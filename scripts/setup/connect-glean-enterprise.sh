#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Connect Claude Code to Plaid's Glean ENTERPRISE instance (official remote
# MCP server, managed OAuth) — for UPFRONT, interactive research while you and
# the agent draft inputs/prompt.txt (account context, Gong calls, collateral).
#
#   ⚠ This is NOT the pipeline's Glean. The headless `research` stage uses
#     @gleanwork/local-mcp-server driven by GLEAN_API_TOKEN + GLEAN_INSTANCE in
#     .env — a totally separate integration. This script never reads or writes
#     .env, and skipping it does not affect pipeline builds.
#
# What it does:
#   1. Registers Glean's remote MCP server in Claude Code, USER-scoped (follows
#      you across projects). Plaid endpoint:
#      https://plaid-be.glean.com/mcp/all-data  (override the server name with
#      GLEAN_MCP_SERVER, the instance with GLEAN_MCP_INSTANCE).
#   2. Tells you how to finish auth: run /mcp inside Claude Code → select
#      "glean" → sign in with your normal Plaid SSO (OAuth — no API token).
#
# Usage:
#   ./scripts/setup/connect-glean-enterprise.sh              # register for instance "plaid"
#   GLEAN_MCP_INSTANCE=acme ./scripts/setup/…                # different instance
#   ./scripts/setup/connect-glean-enterprise.sh --dry-run    # print, don't register
#
# Prereqs: the `claude` CLI, and MCP server capability enabled on the Glean
# instance (a Glean admin setting — it is enabled for Plaid).
# Idempotent: re-running replaces the same user-scoped entry.
# Alternative (Glean's own configurator, same result):
#   npx -y @gleanwork/configure-mcp-server remote \
#     --url https://plaid-be.glean.com/mcp/all-data --client claude-code
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTANCE="${GLEAN_MCP_INSTANCE:-plaid}"
SERVER_NAME="glean"
# Plaid's instance exposes the MCP server named "all-data" (same endpoint the
# claude.ai Glean connector uses); Glean's generic default name is "default".
GLEAN_MCP_SERVER="${GLEAN_MCP_SERVER:-all-data}"
URL="https://${INSTANCE}-be.glean.com/mcp/${GLEAN_MCP_SERVER}"
DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ claude CLI not found — install Claude Code first (https://claude.ai/install.sh)." >&2
  echo "  Then re-run this script, or add manually:" >&2
  echo "  claude mcp add --transport http --scope user ${SERVER_NAME} ${URL}" >&2
  exit 1
fi

# Already connected via ANY entry pointing at this instance's Glean MCP —
# including the claude.ai-managed "claude.ai Glean" connector — don't duplicate.
if claude mcp list 2>/dev/null | grep -qiE "glean.*${INSTANCE}-be\.glean\.com/mcp"; then
  echo "✓ A Glean Enterprise MCP connector for ${INSTANCE} is already registered in Claude Code."
  echo "  If tools aren't loading, finish auth: /mcp → the Glean entry → sign in with SSO."
  exit 0
fi

if [ "${DRY_RUN}" = true ]; then
  echo "Would run: claude mcp add --transport http --scope user ${SERVER_NAME} ${URL}"
  exit 0
fi

# Replace any stale same-name entry, then register user-scoped.
claude mcp remove --scope user "${SERVER_NAME}" >/dev/null 2>&1 || true
claude mcp add --transport http --scope user "${SERVER_NAME}" "${URL}"

cat <<EOF
✓ Glean Enterprise MCP registered user-scoped (${URL}).

Finish in Claude Code (one time):
  1. Restart Claude Code (or open a new session).
  2. Run /mcp → select "${SERVER_NAME}" → Authenticate → sign in with Plaid SSO.
  3. Try it: "Search Glean for the <Account> opportunity and Gong calls, then
     draft inputs/prompt.txt for a demo targeting their use case."

Reminder: the pipeline's research stage uses its own GLEAN_API_TOKEN from .env —
unrelated to this connector; neither replaces the other.
EOF
