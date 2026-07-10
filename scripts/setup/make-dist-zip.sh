#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the manual-download distribution ZIP (ONBOARDING Option B) the safe way:
# `git archive` of HEAD — tracked files only, byte-equivalent to GitHub's
# "Download ZIP" for the same commit — then VERIFY the contents before handing
# it out. Never hand-zip the working directory (that's how a per-machine
# .mcp.json and stale snapshots shipped to users before).
#
# Usage:
#   ./scripts/setup/make-dist-zip.sh [output-dir]     # default: ~/Desktop
#
# Checks:
#   - warns when the working tree is dirty (dirty content is NOT in the ZIP —
#     the archive is exactly HEAD; commit first if those changes should ship)
#   - must-have files present (installer, vendored AskBill server, MCP template,
#     .env.example, onboarding docs)
#   - must-not files absent (.env, .mcp.json, node_modules/, out/, artifacts/)
# A failed check deletes the ZIP and exits non-zero.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

OUT_DIR="${1:-${HOME}/Desktop}"
PREFIX="plaid-demo-recorder"
SHA="$(git rev-parse --short HEAD)"
ZIP="${OUT_DIR}/${PREFIX}-${SHA}.zip"

MUST_HAVE=(
  package.json
  ONBOARDING.md
  ONBOARDING-bootstrap.txt
  .env.example
  .mcp.json.template
  scripts/setup/install.sh
  scripts/setup/connect-glean-enterprise.sh
  scripts/setup/mcp-servers/askbill-plaid/askbill_mcp_server.py
)
MUST_NOT=(
  .env
  .mcp.json
  node_modules/
  out/
  artifacts/
)

if [ -n "$(git status --porcelain)" ]; then
  echo "! Working tree is DIRTY — these changes are NOT in the ZIP (it archives HEAD=${SHA}):"
  git status --porcelain | sed 's/^/    /'
  echo "  Commit them first if they should ship."
fi

mkdir -p "${OUT_DIR}"
git archive --format=zip --prefix="${PREFIX}/" -o "${ZIP}" HEAD

LISTING="$(unzip -Z1 "${ZIP}")"
FAIL=0
for f in "${MUST_HAVE[@]}"; do
  if ! printf '%s\n' "${LISTING}" | grep -qxF "${PREFIX}/${f}"; then
    echo "✗ MISSING from ZIP: ${f} (is it committed?)"
    FAIL=1
  fi
done
for f in "${MUST_NOT[@]}"; do
  # Exact-name match for files, prefix match for dirs (trailing /) — a naive
  # regex here false-positives: unescaped ".env" matches ".env.example".
  esc="$(printf '%s' "${f}" | sed 's/[.[\*^$()+?{|]/\\&/g')"
  case "${f}" in
    */) pattern="^${PREFIX}/${esc}" ;;
    *)  pattern="^${PREFIX}/${esc}$" ;;
  esac
  if printf '%s\n' "${LISTING}" | grep -qE "${pattern}"; then
    echo "✗ MUST-NOT file present in ZIP: ${f}"
    FAIL=1
  fi
done

if [ "${FAIL}" -ne 0 ]; then
  rm -f "${ZIP}"
  echo "✗ Verification failed — ZIP deleted. Fix the issues above and re-run."
  exit 1
fi

echo "✓ $(printf '%s\n' "${LISTING}" | wc -l | tr -d ' ') files, $(du -h "${ZIP}" | cut -f1 | tr -d ' ') — verified (commit ${SHA})"
echo "✓ ${ZIP}"
echo "Next: upload to the shared Drive location and update the ONBOARDING link if it changed."
