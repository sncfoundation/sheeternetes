#!/usr/bin/env bash
#
# End-to-end test of the Virtual Kubelet provider (CI only: needs docker + kind).
#
#   local apiserver (real Code.gs)  <-  kubelet.sh on this host (real docker)
#            ^
#            |  SHEET_URL
#   kind cluster  ->  sheeternetes-vk Deployment  ->  Node "sheet"
#
# A Pod that selects the node must reach Running, show its log line through
# `kubectl logs`, and disappear from docker after `kubectl delete`.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER="${CLUSTER:-sheeternetes-e2e}"
IMAGE="sheeternetes-vk:e2e"
KCTL=(kubectl --context "kind-$CLUSTER")
run="$here/.run"; mkdir -p "$run"

cleanup() {
  [ -f "$run/kubelet.pid" ] && kill "$(cat "$run/kubelet.pid")" 2>/dev/null || true
  [ -f "$run/apiserver.pid" ] && kill "$(cat "$run/apiserver.pid")" 2>/dev/null || true
}
trap cleanup EXIT

dump() {
  echo "---- diagnostics"; "${KCTL[@]}" get nodes -o wide || true
  "${KCTL[@]}" -n sheeternetes logs deploy/sheeternetes-vk --tail=80 || true
  "${KCTL[@]}" describe pod hello-sheet || true
  curl -s "http://127.0.0.1:8787/exec?token=CHANGE_ME_super_secret&kind=pods" || true; echo
  tail -n 30 "$run/kubelet.log" || true
}

echo "== control plane + one docker host"
PORT=8787 NO_SAMPLES=1 node "$here/hack/local-apiserver.js" > "$run/apiserver.log" 2>&1 &
echo $! > "$run/apiserver.pid"
sleep 1
WEBAPP_URL=http://127.0.0.1:8787/exec NODE_NAME=gh-runner NODE_IP=127.0.0.1 \
  CPU_TOTAL=2000 MEM_TOTAL=2048 INTERVAL=3 "$here/kubelet.sh" > "$run/kubelet.log" 2>&1 &
echo $! > "$run/kubelet.pid"
sleep 5

echo "== kind cluster + the virtual kubelet"
docker build -q -t "$IMAGE" -f "$here/virtual-kubelet/Dockerfile" "$here"
kind load docker-image "$IMAGE" --name "$CLUSTER"
gw="$(docker network inspect kind | jq -r '.[0].IPAM.Config[] | select(.Gateway | test("^[0-9.]+$")) | .Gateway' | head -1)"
echo "host as seen from kind: $gw"
"${KCTL[@]}" create namespace sheeternetes
"${KCTL[@]}" -n sheeternetes create secret generic sheeternetes-sheet \
  --from-literal=url="http://$gw:8787/exec" --from-literal=token=CHANGE_ME_super_secret
sed -e "s#ghcr.io/sncfoundation/sheeternetes-vk:latest#$IMAGE#" \
    -e "s#^\(\s*\)image: $IMAGE#&\n\1imagePullPolicy: Never#" \
    "$here/virtual-kubelet/deploy/sheeternetes-vk.yaml" | "${KCTL[@]}" apply -f -

for _ in $(seq 60); do
  "${KCTL[@]}" get node sheet >/dev/null 2>&1 && break; sleep 2
done
"${KCTL[@]}" wait --for=condition=Ready node/sheet --timeout=120s || { dump; exit 1; }
"${KCTL[@]}" get node sheet -o wide

echo "== a pod in a spreadsheet"
"${KCTL[@]}" apply -f "$here/virtual-kubelet/examples/hello-pod.yaml"
"${KCTL[@]}" wait --for=condition=Ready pod/hello-sheet --timeout=180s || { dump; exit 1; }
"${KCTL[@]}" get pod hello-sheet -o wide
docker ps --filter label=sheeternetes.node=gh-runner --format '{{.Names}} {{.Image}}' | tee "$run/containers.txt"
grep -q busybox "$run/containers.txt" || { echo "no docker container for the pod"; dump; exit 1; }

ok=""
for _ in $(seq 30); do
  if "${KCTL[@]}" logs hello-sheet 2>/dev/null | grep -q "hello from a spreadsheet"; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || { echo "kubectl logs never showed the line"; "${KCTL[@]}" logs hello-sheet || true; dump; exit 1; }
echo "kubectl logs: $("${KCTL[@]}" logs hello-sheet)"

echo "== delete"
"${KCTL[@]}" delete pod hello-sheet --timeout=120s
gone=""
for _ in $(seq 30); do
  if ! docker ps --filter label=sheeternetes.node=gh-runner --format '{{.Image}}' | grep -q busybox; then gone=1; break; fi
  sleep 2
done
[ -n "$gone" ] || { echo "container still running after kubectl delete"; dump; exit 1; }
echo "PASS: a Kubernetes pod ran in a spreadsheet, logged, and was deleted"
