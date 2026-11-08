#!/usr/bin/env bash
#
# kubectl against a spreadsheet: start the local apiserver (real Code.gs), a
# kubelet, and the Kubernetes API facade, then drive it with a real kubectl.
#
#   hack/e2e-kube-facade.sh                 # fake kubelet (no Docker needed)
#   KUBELET=docker hack/e2e-kube-facade.sh  # real kubelet.sh + Docker (CI)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
run="$here/.run/facade-e2e"; mkdir -p "$run"
APORT="${APORT:-8790}"; FPORT="${FPORT:-6450}"
W="http://127.0.0.1:$APORT/exec"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

PORT="$APORT" NO_SAMPLES=1 node "$here/hack/local-apiserver.js" > "$run/apiserver.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -fs "$W?token=CHANGE_ME_super_secret&kind=nodes" >/dev/null 2>&1 && break; sleep 0.2; done
if [ "${KUBELET:-fake}" = docker ]; then
  WEBAPP_URL="$W" NODE_NAME=node-a NODE_IP=127.0.0.1 CPU_TOTAL=2000 MEM_TOTAL=2048 INTERVAL=2 \
    "$here/kubelet.sh" > "$run/kubelet.log" 2>&1 & pids+=($!)
else
  WEBAPP_URL="$W" NODE_NAME=node-a CPU_TOTAL=2000 MEM_TOTAL=2048 node "$here/hack/fake-kubelet.js" > "$run/kubelet.log" 2>&1 & pids+=($!)
fi
go build -o "$run/facade" "$here/kube-facade"
"$run/facade" --sheet-url "$W" --listen "127.0.0.1:$FPORT" --poll 500ms --token e2e \
  --write-kubeconfig "$run/kubeconfig" > "$run/facade.log" 2>&1 & pids+=($!)
for _ in $(seq 50); do curl -kfs -H 'Authorization: Bearer e2e' "https://127.0.0.1:$FPORT/version" >/dev/null 2>&1 && break; sleep 0.2; done

k() { kubectl --kubeconfig "$run/kubeconfig" --context sheeternetes "$@"; }
pass=0
ok() { pass=$((pass + 1)); echo "  PASS $*"; }
fail() { echo "  FAIL $*"; echo "---- facade log"; tail -n 30 "$run/facade.log"; exit 1; }
must() { # must <description> <command...>
  local d="$1"; shift
  if "$@"; then ok "$d"; else fail "$d"; fi
}
waitfor() { # waitfor <seconds> <description> <command...>
  local t="$1" d="$2"; shift 2
  for _ in $(seq "$t"); do "$@" >/dev/null 2>&1 && { ok "$d"; return; }; sleep 1; done
  fail "$d"
}

echo "== discovery + nodes"
must "kubectl version shows the spreadsheet server" bash -c "kubectl --kubeconfig '$run/kubeconfig' version | grep -q sheeternetes"
must "api-resources lists deployments" bash -c "kubectl --kubeconfig '$run/kubeconfig' api-resources | grep -q deployments"
waitfor 20 "node-a is Ready" bash -c "kubectl --kubeconfig '$run/kubeconfig' get nodes | grep -q 'node-a .*Ready'"
must "describe node" bash -c "kubectl --kubeconfig '$run/kubeconfig' describe node node-a | grep -q 'Kubelet Version:.*kubelet.sh'"

echo "== create, get, describe"
must "kubectl create deployment" k create deployment web --image=busybox:1.36 --replicas=2 -- sh -c 'echo serving from a spreadsheet; sleep 3600'
waitfor 40 "2/2 replicas Running" bash -c "kubectl --kubeconfig '$run/kubeconfig' get deploy web | grep -q ' 2/2 '"
k get pods -o wide | tee "$run/pods.txt"
must "kubectl get pods shows 2 Running" [ "$(grep -c Running "$run/pods.txt")" = 2 ]
pod="$(k get pods -l app=web -o jsonpath='{.items[0].metadata.name}')"
must "describe pod" bash -c "kubectl --kubeconfig '$run/kubeconfig' describe pod '$pod' | grep -q 'Image:.*busybox:1.36'"
must "describe deployment" bash -c "kubectl --kubeconfig '$run/kubeconfig' describe deploy web | grep -q '2 desired'"
must "get -o yaml" bash -c "kubectl --kubeconfig '$run/kubeconfig' get pod '$pod' -o yaml | grep -q 'nodeName: node-a'"
must "events mention the pod" bash -c "kubectl --kubeconfig '$run/kubeconfig' get events | grep -q '$pod'"

echo "== logs"
waitfor 30 "kubectl logs returns the container output" bash -c \
  "kubectl --kubeconfig '$run/kubeconfig' logs '$pod' | grep -Eq 'serving from a spreadsheet|hello from $pod'"

echo "== scale"
must "kubectl scale" k scale deployment web --replicas=4
waitfor 40 "4/4 after scale" bash -c "kubectl --kubeconfig '$run/kubeconfig' get deploy web | grep -q ' 4/4 '"

echo "== watch"
k get pods -w --request-timeout=6s > "$run/watch.txt" 2>&1 &
wpid=$!
sleep 2
k scale deployment web --replicas=5 >/dev/null
wait "$wpid" || true
if [ "$(grep -c web- "$run/watch.txt")" -ge 5 ]; then ok "kubectl get -w streams the new pod"; else fail "watch: $(cat "$run/watch.txt")"; fi

echo "== cordon"
must "kubectl cordon" k cordon node-a
must "node shows SchedulingDisabled" bash -c "kubectl --kubeconfig '$run/kubeconfig' get nodes | grep -q SchedulingDisabled"
must "kubectl uncordon" k uncordon node-a

echo "== delete"
must "kubectl delete pod (waits until it is gone)" k delete pod "$pod" --timeout=60s
waitfor 40 "deployment replaces the deleted pod" bash -c "kubectl --kubeconfig '$run/kubeconfig' get deploy web | grep -q ' 5/5 '"
must "kubectl delete deployment" k delete deployment web --timeout=60s
if k get deploy web >/dev/null 2>&1; then fail "deployment still there"; else ok "deployment is gone"; fi

echo "==== $pass passed ===="
