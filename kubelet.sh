#!/usr/bin/env bash
#
# Sheeternetes kubelet — runs on any Docker host and turns it into a "node".
# It heartbeats the Apps Script apiserver, receives the pods it should run,
# and converges local Docker state to match. Requires: bash, curl, jq, docker.
#
# Usage:
#   WEBAPP_URL=https://script.google.com/macros/s/XXXX/exec \
#   TOKEN=CHANGE_ME_super_secret \
#   NODE_NAME=node-a CPU_TOTAL=4000 MEM_TOTAL=8192 \
#   ./kubelet.sh
#
set -euo pipefail

WEBAPP_URL="${WEBAPP_URL:?set WEBAPP_URL to the Apps Script web app /exec URL}"
TOKEN="${TOKEN:-CHANGE_ME_super_secret}"
NODE_NAME="${NODE_NAME:-$(hostname)}"
# Linux: hostname -I; macOS: ipconfig; fall back to loopback if both are empty.
NODE_IP="${NODE_IP:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
NODE_IP="${NODE_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
NODE_IP="${NODE_IP:-127.0.0.1}"
CPU_TOTAL="${CPU_TOTAL:-$(( $(nproc 2>/dev/null || echo 2) * 1000 ))}"   # millicores
MEM_TOTAL="${MEM_TOTAL:-2048}"                                            # MiB
INTERVAL="${INTERVAL:-10}"                                                # seconds
NODE_LABELS="${NODE_LABELS:-}"      # e.g. disk=ssd,zone=eu   (matched by node_selector)
LOG_TAIL="${LOG_TAIL:-20}"          # log lines per pod shipped on each heartbeat
REPORT_STATS="${REPORT_STATS:-1}"   # report docker stats (cpu/mem usage) for autoscaling
NODE_TAINTS="${NODE_TAINTS:-}"      # e.g. gpu=true:NoSchedule (needs a toleration)

echo "[kubelet] node=$NODE_NAME ip=$NODE_IP cpu=${CPU_TOTAL}m mem=${MEM_TOTAL}Mi -> $WEBAPP_URL"

# Sheetlium: a shared Docker network so pods can reach each other, and each
# deployment name becomes a round-robin DNS alias == a Service (single-daemon;
# real multi-host would need an overlay network).
SK_NET="${SK_NET:-sheeternetes}"
docker network inspect "$SK_NET" >/dev/null 2>&1 || docker network create "$SK_NET" >/dev/null 2>&1 || true

# name of the docker container backing a pod
cname() { echo "sk_$1"; }

while true; do
  # 1) report the pods we currently run (only ours, by node label)
  running_json="$(
    docker ps --filter "label=sheeternetes.node=$NODE_NAME" \
      --format '{{.Label "sheeternetes.pod"}}|{{.ID}}' \
    | jq -R -s 'split("\n") | map(select(length>0) | split("|"))
                | map({name: .[0], phase: "Running", container_id: .[1]})'
  )"
  [ -z "$running_json" ] && running_json='[]'
  # observed usage per pod from `docker stats` (millicores, MiB) for the Autoscale
  # tab; docker's CPU% is per core, so 100% = 1000m. REPORT_STATS=0 disables it.
  if [ "$REPORT_STATS" = 1 ] && [ "$running_json" != '[]' ]; then
    # shellcheck disable=SC2046  # one argument per container id
    stats_json="$(docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}' \
        $(docker ps -q --filter "label=sheeternetes.node=$NODE_NAME") 2>/dev/null \
      | jq -R -s '
          def mib: capture("(?<n>[0-9.]+)\\s*(?<u>[A-Za-z]*)") as $m | ($m.n | tonumber) *
            ({"B":0.00000095367,"kB":0.00095367,"KiB":0.0009765625,"MB":0.95367,"MiB":1,"GB":953.67,"GiB":1024}[$m.u] // 1);
          split("\n") | map(select(length > 0) | split("|")
            | {key: (.[0] | ltrimstr("sk_")),
               value: {cpu_usage: (.[1] | rtrimstr("%") | tonumber * 10 | round),
                       mem_usage: (.[2] | split(" / ")[0] | mib | round)}})
          | from_entries' || true)"
    [ -n "$stats_json" ] || stats_json='{}'
    running_json="$(echo "$running_json" | jq -c --argjson s "$stats_json" 'map(. + ($s[.name] // {}))')"
  fi
  # ship the last LOG_TAIL lines of every pod (read back by `kubectl logs` via the
  # Virtual Kubelet provider / API facade); LOG_TAIL=0 disables it
  if [ "$LOG_TAIL" -gt 0 ]; then
    with_logs='[]'
    while read -r p <&4; do
      cid="$(echo "$p" | jq -r '.container_id')"
      tail_txt="$(docker logs --tail "$LOG_TAIL" "$cid" 2>&1 | tail -c 4000 || true)"
      with_logs="$(echo "$with_logs" | jq -c --argjson p "$p" --arg l "$tail_txt" '. + [$p + {logs: $l}]')"
    done 4< <(echo "$running_json" | jq -c '.[]')
    running_json="$with_logs"
  fi

  # 2) heartbeat + fetch desired state
  resp="$(curl -fsSL -m 30 -X POST "$WEBAPP_URL" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n \
          --arg t "$TOKEN" --arg n "$NODE_NAME" --arg ip "$NODE_IP" \
          --argjson cpu "$CPU_TOTAL" --argjson mem "$MEM_TOTAL" \
          --argjson pods "$running_json" \
          --arg labels "$NODE_LABELS" --arg taints "$NODE_TAINTS" \
          '{token:$t, node:$n, ip:$ip, cpu_total:$cpu, mem_total:$mem, labels:$labels, taints:$taints, pods:$pods}')" \
    || echo '{"pods":[]}')"

  desired="$(echo "$resp" | jq -c '.pods // []')"

  # 3) converge: start Running that are missing, remove Terminating.
  # Read the pod stream on FD 3 so docker commands in the body can't drain it.
  while read -r pod <&3; do
    name="$(echo "$pod"  | jq -r '.name')"
    want="$(echo "$pod"  | jq -r '.desired')"
    cn="$(cname "$name")"

    if [ "$want" = "Running" ]; then
      if ! docker ps -q -f "name=^${cn}$" | grep -q .; then
        image="$(echo "$pod" | jq -r '.image')"
        cmd="$(echo "$pod"   | jq -r '.command // ""')"
        cpu="$(echo "$pod"   | jq -r '.cpu_req // 100')"
        mem="$(echo "$pod"   | jq -r '.mem_req // 64')"
        deploy="$(echo "$pod" | jq -r '.deployment // empty')"
        # millicores -> docker's fractional --cpus, locale-independent (no awk)
        cpus="$((cpu / 1000)).$(printf '%03d' "$((cpu % 1000))")"
        # Sheetlium: join the shared net; alias = deployment name (the Service)
        net_args=(--network "$SK_NET")
        [ -n "$deploy" ] && net_args+=(--network-alias "$deploy")
        echo "[kubelet] run $name ($image)"
        docker rm -f "$cn" >/dev/null 2>&1 || true
        # command (if any) is run through a shell so quoting/loops survive
        if [ -n "$cmd" ] && [ "$cmd" != "null" ]; then
          docker run -d --name "$cn" \
            --label sheeternetes=1 --label "sheeternetes.pod=$name" \
            --label "sheeternetes.node=$NODE_NAME" \
            "${net_args[@]}" --cpus "$cpus" --memory "${mem}m" \
            "$image" sh -c "$cmd" >/dev/null || echo "[kubelet] FAILED to start $name"
        else
          docker run -d --name "$cn" \
            --label sheeternetes=1 --label "sheeternetes.pod=$name" \
            --label "sheeternetes.node=$NODE_NAME" \
            "${net_args[@]}" --cpus "$cpus" --memory "${mem}m" \
            "$image" >/dev/null || echo "[kubelet] FAILED to start $name"
        fi
      fi
    elif [ "$want" = "Terminating" ]; then
      if docker ps -aq -f "name=^${cn}$" | grep -q .; then
        echo "[kubelet] stop $name"
        docker rm -f "$cn" >/dev/null 2>&1 || true
      fi
    fi
  done 3< <(echo "$desired" | jq -c '.[]')

  # 4) garbage-collect pods no longer desired at all (only ours)
  desired_names="$(echo "$desired" | jq -r '.[].name')"
  while read -r have <&3; do
    [ -z "$have" ] && continue
    if ! echo "$desired_names" | grep -qx "$have"; then
      echo "[kubelet] gc $have"
      docker rm -f "$(cname "$have")" >/dev/null 2>&1 || true
    fi
  done 3< <(docker ps --filter "label=sheeternetes.node=$NODE_NAME" --format '{{.Label "sheeternetes.pod"}}')

  sleep "$INTERVAL"
done
