#!/usr/bin/env bash
# Print `npm run pipe -- status` on an interval while a pipeline runs elsewhere.
# Agent/human runs this in a second terminal; Claude Code rules in CLAUDE.md still
# require periodic status in chat — this script only mirrors status to the shell.
#
# Usage (repo root):
#   npm run pipe:status-loop
#   PIPE_STATUS_INTERVAL_SEC=120 npm run pipe:status-loop
set -euo pipefail
INTERVAL_SEC="${PIPE_STATUS_INTERVAL_SEC:-300}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

echo "pipe-status-loop: status every ${INTERVAL_SEC}s (Ctrl+C to stop)"
while true; do
  echo ""
  echo "=== $(date -u +"%Y-%m-%dT%H:%M:%SZ")  npm run pipe -- status ==="
  npm run pipe -- status || true
  sleep "${INTERVAL_SEC}"
done
