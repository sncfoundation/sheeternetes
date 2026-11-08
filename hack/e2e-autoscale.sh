#!/usr/bin/env bash
#
# Autoscaling with real containers (CI: needs docker). A busy-loop deployment
# asks for 200m; kubelet.sh reports `docker stats`; the Autoscale tab's formulas
# want more replicas; the reconcile loop scales up to max.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
run="$here/.run/autoscale-e2e"; mkdir -p "$run"
PORT="${APORT:-8792}"
export WEBAPP_URL="http://127.0.0.1:$PORT/exec" TOKEN=CHANGE_ME_super_secret
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  docker ps -aq --filter label=sheeternetes.node=hpa-node | xargs docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

PORT="$PORT" NO_SAMPLES=1 node "$here/hack/local-apiserver.js" > "$run/apiserver.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -fs "$WEBAPP_URL?token=$TOKEN&kind=nodes" >/dev/null 2>&1 && break; sleep 0.2; done
NODE_NAME=hpa-node NODE_IP=127.0.0.1 CPU_TOTAL=2000 MEM_TOTAL=2048 INTERVAL=3 \
  "$here/kubelet.sh" > "$run/kubelet.log" 2>&1 & pids+=($!)
sleep 4

sk() { WEBAPP_URL="$WEBAPP_URL" TOKEN="$TOKEN" "$here/skctl" "$@"; }

sk apply "$here/lab/autoscale.json" >/dev/null
sk autoscale burner --cpu-percent 50 --min 1 --max 3 >/dev/null
for i in $(seq 60); do
  replicas="$(curl -fs "$WEBAPP_URL?token=$TOKEN&kind=deployments" | jq -r '.items[] | select(.name=="burner") | .replicas')"
  # the status turns LimitedByMax only once the new replicas run and report usage
  status="$(curl -fs "$WEBAPP_URL?token=$TOKEN&kind=autoscale" | jq -r '.items[] | select(.deployment=="burner") | .status')"
  [ "$replicas" = 3 ] && [ "$status" = LimitedByMax ] && break
  [ $((i % 5)) = 0 ] && sk get hpa
  sleep 3
done
sk get hpa | tee "$run/hpa.txt"
sk get pods
sk get events | grep Autoscale || true
[ "$replicas" = 3 ] || { echo "FAIL: burner has $replicas replicas, want 3"; tail -n 20 "$run/kubelet.log"; exit 1; }
grep -q LimitedByMax "$run/hpa.txt" || { echo "FAIL: status should be LimitedByMax"; exit 1; }
[ "$(docker ps -q --filter label=sheeternetes.node=hpa-node | wc -l)" -ge 3 ] || { echo "FAIL: fewer than 3 containers"; exit 1; }
echo "PASS: docker stats -> Autoscale formula -> 3 burner containers, LimitedByMax"
