#!/usr/bin/env bash
#
# Spin up a 3-node Sheeternetes cluster on a single Docker daemon, for demos.
# Each "node" is a kubelet.sh process with its own node label, so they don't
# fight over each other's containers.
#
#   WEBAPP_URL=... TOKEN=... ./local-cluster.sh
#   ./local-cluster.sh stop     # kill the local nodes
#
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$here/.skctl.env" ] && . "$here/.skctl.env"
export WEBAPP_URL TOKEN

if [ "${1:-start}" = "stop" ]; then
  pkill -f 'kubelet.sh' 2>/dev/null || true
  docker ps -aq --filter "label=sheeternetes=1" | xargs docker rm -f >/dev/null 2>&1 || true
  echo "stopped local nodes and removed their containers"
  exit 0
fi

mkdir -p "$here/.run"
for i in a b c; do
  NODE_NAME="node-$i" NODE_IP="127.0.0.1" \
  CPU_TOTAL=2000 MEM_TOTAL=2048 INTERVAL=8 \
  nohup "$here/kubelet.sh" > "$here/.run/node-$i.log" 2>&1 &
  echo "started node-$i (log: .run/node-$i.log)"
done
echo "3 nodes heartbeating. Try: ./skctl get nodes"
