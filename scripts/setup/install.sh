#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Plaid Demo Recorder — one-command installer for Sales Engineering teammates
#
# Usage:
#   bash scripts/setup/install.sh                  # interactive
#   bash scripts/setup/install.sh --non-interactive
#
# What this script does (all optional prompts when anything is missing):
#   1. Verifies prerequisites (node >= 20, npm, git, gh CLI, ffmpeg). If gh or
#      ffmpeg is missing and Homebrew is available, offers (or in --non-interactive
#      mode runs) brew install; otherwise prints manual install URLs.
#   2. Runs `npm install` to fetch Node dependencies.
#   3. Creates a local `.env` from `.env.example` if one doesn't exist; optionally
#      prompts to paste secrets (default: skip). If you skip, reach out to the
#      repository owner for real `.env` keys — never commit secrets.
#      (Google embeddings use GOOGLE_API_KEY via gemini-embedding-2 — no GCP
#      service-account JSON / ADC; nothing to set up here.)
#   3b. When .env lists Glean (token + instance) and/or AskBill mcp-remote settings,
#      prefetches @gleanwork/local-mcp-server and/or mcp-remote into the npm cache.
#   4. Runs `gh auth status` to confirm the user is signed in to their
#      GitHub Enterprise host; offers to run `gh auth login` if not.
#      When auth is missing, prints step-by-step hints for users who have
#      never used `gh` or signed in to GitHub before.
#   5. Resolves and caches the user's GHE identity
#      (~/.plaid-demo-recorder/identity.json) via `npm run pipe -- whoami`.
#   6. Clones (or refreshes) the artifact repo `plaid-demo-apps` at
#      `~/.plaid-demo-apps` so shared demos are immediately available.
#   7. Installs a Playwright browser for the recorder (`npx playwright install chromium`).
#   7b. Sets up the render engine: ensures `uv` and clones the canonical
#      vidmagik-mcp MoviePy server (github.com/vizionik25/vidmagik-mcp, branch
#      pipeline-patches) to ~/.mcp-servers/mcp-moviepy. Optional + graceful —
#      app-only builds skip it; a failure only falls render back to Remotion.
#      Skip with --skip-render-engine or SKIP_RENDER_ENGINE=true.
#   8. Prints the quick-start commands for building a first demo.
#
# This script is INTENTIONALLY idempotent — re-running it on an already-set-up
# machine skips every step whose outcome is already satisfied. Safe to use for
# both first-time setup and "keep my install up to date" maintenance.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

NON_INTERACTIVE=false
SKIP_RENDER_ENGINE="${SKIP_RENDER_ENGINE:-false}"
for arg in "$@"; do
  case "$arg" in
    --non-interactive|--ci) NON_INTERACTIVE=true ;;
    --skip-render-engine) SKIP_RENDER_ENGINE=true ;;
    -h|--help)
      sed -n '2,/^#\ ──/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

# Colors (disabled when stdout is not a TTY, matching bin/pipe.js convention).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'; RESET=$'\e[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; CYAN=''; RESET=''
fi

heading() { printf "\n${BOLD}▸ %s${RESET}\n" "$1"; }
ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
info()    { printf "  ${CYAN}·${RESET} %s\n" "$1"; }
warn()    { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
err()     { printf "  ${RED}✗${RESET} %s\n" "$1"; }

confirm() {
  local prompt="$1"; local default="${2:-y}"
  if [ "${NON_INTERACTIVE}" = true ]; then
    [ "${default}" = "y" ] && return 0 || return 1
  fi
  local hint="[Y/n]"; [ "${default}" = "n" ] && hint="[y/N]"
  read -r -p "  ? ${prompt} ${hint} " ans || true
  ans="${ans:-${default}}"
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

print_env_owner_message() {
  printf "\n"
  info "${BOLD}Secrets / .env:${RESET} Reach out to the ${BOLD}repository owner${RESET} for environment file keys (API tokens and credentials). Do not paste secrets into chat logs or tickets."
  info "Ensure \`.env\` matches \`.env.example\` structure, then fill values from the maintainer."
  printf "\n"
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  local name="$1"; local hint="${2:-}"
  if have_cmd "$name"; then
    ok "${name} found ($(command -v "$name"))"
    return 0
  fi
  err "${name} not found. ${hint}"
  return 1
}

# Install gh / ffmpeg via Homebrew when missing. Required for this installer.
ensure_github_cli() {
  if have_cmd gh; then
    ok "gh found ($(command -v gh))"
    return 0
  fi
  warn "gh (GitHub CLI) not found — required for \`pipe publish\`, \`pipe pull\`, and identity."
  if have_cmd brew; then
    if [ "${NON_INTERACTIVE}" = true ] || confirm "Install gh with Homebrew (\`brew install gh\`)?" y; then
      info "Running \`brew install gh\` …"
      brew install gh || {
        err "\`brew install gh\` failed."
        return 1
      }
    else
      err "Install gh manually: https://cli.github.com — or run: brew install gh"
      return 1
    fi
  else
    err "Install GitHub CLI: https://cli.github.com — On macOS, install Homebrew from https://brew.sh then re-run this script (it can install gh automatically)."
    return 1
  fi
  if have_cmd gh; then
    ok "gh installed ($(command -v gh))"
    return 0
  fi
  err "gh still not on PATH after install."
  return 1
}

ensure_ffmpeg_bin() {
  if have_cmd ffmpeg; then
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
    return 0
  fi
  warn "ffmpeg not found — required for recording and MP4 render (\`npm run demo:full\`)."
  if have_cmd brew; then
    if [ "${NON_INTERACTIVE}" = true ] || confirm "Install ffmpeg with Homebrew (\`brew install ffmpeg\`)?" y; then
      info "Running \`brew install ffmpeg\` …"
      brew install ffmpeg || {
        err "\`brew install ffmpeg\` failed."
        return 1
      }
    else
      err "Install ffmpeg manually: https://ffmpeg.org/download.html — e.g. Debian/Ubuntu: sudo apt-get install ffmpeg"
      return 1
    fi
  else
    err "Install ffmpeg: macOS Homebrew \`brew install ffmpeg\` (https://brew.sh) — or https://ffmpeg.org/download.html — Debian/Ubuntu: sudo apt-get install ffmpeg"
    return 1
  fi
  if have_cmd ffmpeg; then
    ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
    return 0
  fi
  err "ffmpeg still not on PATH after install."
  return 1
}

# Ensure `uv` (the Python runner the render-engine MCP server uses). Graceful —
# a missing uv is NOT fatal; render falls back to Remotion.
ensure_uv() {
  if have_cmd uv; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"; return 0; fi
  warn "uv not found — needed by the vidmagik-mcp render engine (full-pipeline video only)."
  if have_cmd brew; then
    if [ "${NON_INTERACTIVE}" = true ] || confirm "Install uv with Homebrew (\`brew install uv\`)?" y; then
      info "Running \`brew install uv\` …"
      brew install uv || { warn "\`brew install uv\` failed — install manually: https://docs.astral.sh/uv/"; return 1; }
    else
      warn "Skipped uv — install later: brew install uv (or https://docs.astral.sh/uv/)"; return 1
    fi
  else
    warn "Install uv: https://docs.astral.sh/uv/ (then re-run this script)"; return 1
  fi
  have_cmd uv && { ok "uv installed"; return 0; }
  return 1
}

# Render engine — clone/refresh the CANONICAL vidmagik-mcp MoviePy server on its
# pipeline-patches branch. Always returns 0 (a failure here only means render
# falls back to Remotion, lower fidelity — never block the install).
RENDER_MCP_DIR="${HOME}/.mcp-servers/mcp-moviepy"
RENDER_MCP_REPO="https://github.com/vizionik25/vidmagik-mcp.git"   # NOT vizionik25/moviepy-mcp (different project)
RENDER_MCP_BRANCH="pipeline-patches"

# Rewrite committed ABSOLUTE MCP-server home paths in .mcp.json to THIS machine's
# $HOME. .mcp.json ships with the committer's paths (e.g. /Users/<committer>/…);
# a fresh clone otherwise points the askbill + moviepy MCP servers at a home dir
# that doesn't exist here, and the agent CANNOT fix .mcp.json (the harness blocks
# edits to its own startup config), so this user-run step is the fix. Targets only
# the two known MCP parents (plaid-mcp-servers, .mcp-servers) so nothing else is
# touched. Idempotent; backs up to .mcp.json.bak only when it actually changes.
# (Astera 2026-06-30: the moviepy path was still /Users/<other>/… after clone.)
normalize_mcp_json() {
  local mcp="${REPO_ROOT}/.mcp.json"
  [ -f "${mcp}" ] || return 0
  local tmp; tmp="$(mktemp)" || return 0
  # NOTE: use '#' as the sed delimiter — '|' collides with the (Users|home)
  # alternation on BSD/macOS sed ("parentheses not balanced").
  sed -E \
    -e "s#/(Users|home)/[^/\"]+/plaid-mcp-servers/#${HOME}/plaid-mcp-servers/#g" \
    -e "s#/(Users|home)/[^/\"]+/\.mcp-servers/#${HOME}/.mcp-servers/#g" \
    "${mcp}" > "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
  if ! cmp -s "${mcp}" "${tmp}"; then
    cp "${mcp}" "${mcp}.bak" 2>/dev/null || true
    mv "${tmp}" "${mcp}"
    ok ".mcp.json MCP paths normalized to ${HOME} (backup: .mcp.json.bak) — restart the agent to load them."
  else
    rm -f "${tmp}"
    info ".mcp.json MCP paths already match ${HOME}."
  fi
  # Verify the referenced server dirs actually exist — a normalized path pointing
  # at a missing dir is the other half of the Astera gap (the server was never
  # cloned to this $HOME). Warn with a concrete pointer; never block.
  [ -d "${HOME}/.mcp-servers/mcp-moviepy" ] || \
    warn "moviepy MCP server missing at ${HOME}/.mcp-servers/mcp-moviepy — interactive moviepy tools won't load (render is unaffected)."
  # AskBill: a dir-exists check isn't enough — verify the EXACT interpreter + script
  # .mcp.json will launch, and that the venv can import the server's deps.
  verify_askbill_mcp
}

# Verify the askbill-plaid MCP server is actually launchable, not just present.
# Reads the server's `command` (venv python) + `args[0]` (server script) straight
# from .mcp.json, confirms both exist, and runs an `import mcp, websockets` smoke
# test against that interpreter (the server's only non-stdlib imports; there is no
# requirements.txt). If the script exists but the venv is missing/incomplete, it
# self-heals (create venv + pip install the two deps). The server SCRIPT itself is
# provisioned out-of-band (internal), so a missing script only warns. Never blocks.
verify_askbill_mcp() {
  local mcp="${REPO_ROOT}/.mcp.json"
  [ -f "${mcp}" ] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    [ -d "${HOME}/plaid-mcp-servers/askbill-plaid" ] \
      && info "askbill MCP dir present (python3 unavailable — skipping deep verify)." \
      || warn "askbill MCP server missing — research (AskBill) tools won't load."
    return 0
  fi
  # Pull command + first arg for the askbill-plaid server out of .mcp.json.
  local parsed cmd script srv_dir
  parsed="$(python3 - "${mcp}" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
srv = (d.get('mcpServers') or d.get('servers') or {}).get('askbill-plaid') or {}
args = srv.get('args') or []
print(srv.get('command') or '')
print(args[0] if args else '')
PY
)"
  cmd="$(printf '%s\n' "${parsed}" | sed -n '1p')"
  script="$(printf '%s\n' "${parsed}" | sed -n '2p')"
  if [ -z "${cmd}${script}" ]; then
    warn "askbill-plaid not found in .mcp.json — AskBill research tools won't load."
    return 0
  fi
  # 1. Server script must exist (obtained out-of-band — not cloneable here).
  if [ ! -f "${script}" ]; then
    warn "askbill MCP server script missing at ${script:-<unset>} — research (AskBill) tools won't load. Obtain the askbill-plaid server from the repo owner into ${HOME}/plaid-mcp-servers/askbill-plaid/."
    return 0
  fi
  srv_dir="$(dirname "${script}")"
  # 2. Interpreter (venv python) must exist; create the venv if it's absent.
  if [ ! -x "${cmd}" ]; then
    warn "askbill venv python missing at ${cmd} — creating venv..."
    python3 -m venv "${srv_dir}/venv" >/dev/null 2>&1 || true
  fi
  # 3. Smoke-test the EXACT interpreter .mcp.json launches against the server's deps.
  if [ -x "${cmd}" ] && "${cmd}" -c "import mcp, websockets" >/dev/null 2>&1; then
    ok "askbill MCP verified — server script + venv deps (mcp, websockets) load."
    return 0
  fi
  # 4. Deps missing → install the server's two non-stdlib imports into the venv.
  if [ -x "${cmd}" ]; then
    info "askbill venv missing deps — installing mcp + websockets..."
    "${cmd}" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
    "${cmd}" -m pip install --quiet mcp websockets >/dev/null 2>&1 || true
    if "${cmd}" -c "import mcp, websockets" >/dev/null 2>&1; then
      ok "askbill MCP verified — installed mcp + websockets into the venv."
      return 0
    fi
  fi
  warn "askbill MCP present but its venv can't import mcp/websockets (${cmd:-<unset>}). Recreate it: python3 -m venv \"${srv_dir}/venv\" && \"${srv_dir}/venv/bin/pip\" install mcp websockets. AskBill research tools won't load until this passes."
}

setup_render_engine() {
  if [ "${SKIP_RENDER_ENGINE}" = true ]; then
    info "Skipping render engine (SKIP_RENDER_ENGINE / --skip-render-engine). App-only builds don't need it."
    return 0
  fi
  ensure_uv || { warn "Render engine setup skipped (no uv). Full-pipeline render will fall back to Remotion."; return 0; }
  mkdir -p "$(dirname "${RENDER_MCP_DIR}")" 2>/dev/null || true
  if [ -d "${RENDER_MCP_DIR}/.git" ]; then
    info "Refreshing vidmagik-mcp at ${RENDER_MCP_DIR}"
    git -C "${RENDER_MCP_DIR}" fetch origin "${RENDER_MCP_BRANCH}" 2>/dev/null \
      && git -C "${RENDER_MCP_DIR}" checkout "${RENDER_MCP_BRANCH}" 2>/dev/null \
      && git -C "${RENDER_MCP_DIR}" pull --ff-only 2>/dev/null \
      || warn "Could not fast-forward vidmagik-mcp — resolve manually in ${RENDER_MCP_DIR}."
  elif [ -e "${RENDER_MCP_DIR}" ]; then
    warn "${RENDER_MCP_DIR} exists but is not a git clone — leaving as-is."
  else
    info "Cloning ${RENDER_MCP_REPO} → ${RENDER_MCP_DIR} (branch ${RENDER_MCP_BRANCH})"
    if git clone --branch "${RENDER_MCP_BRANCH}" "${RENDER_MCP_REPO}" "${RENDER_MCP_DIR}" 2>/dev/null; then
      :
    else
      # Older git without --branch on a non-default branch, or clone failed: try plain clone + checkout.
      git clone "${RENDER_MCP_REPO}" "${RENDER_MCP_DIR}" 2>/dev/null \
        && git -C "${RENDER_MCP_DIR}" checkout "${RENDER_MCP_BRANCH}" 2>/dev/null \
        || { warn "Could not clone vidmagik-mcp — render will fall back to Remotion. Clone manually: git clone ${RENDER_MCP_REPO} ${RENDER_MCP_DIR} && (cd ${RENDER_MCP_DIR} && git checkout ${RENDER_MCP_BRANCH})"; return 0; }
    fi
  fi
  if [ -f "${RENDER_MCP_DIR}/main.py" ]; then
    local br; br="$(git -C "${RENDER_MCP_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    ok "vidmagik-mcp ready at ${RENDER_MCP_DIR} (branch ${br})"
  else
    warn "vidmagik-mcp present but main.py missing — verify the clone."
  fi
  # Point .mcp.json's moviepy (and askbill) entries at THIS machine's $HOME. The
  # render pipeline resolves ~/.mcp-servers/mcp-moviepy portably via os.homedir()
  # regardless, but the INTERACTIVE agent MCP tools read .mcp.json literally — so
  # normalize it here rather than only warning.
  normalize_mcp_json
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. Prerequisite check
# ─────────────────────────────────────────────────────────────────────────────
heading "Checking prerequisites"

FAIL=0

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "${NODE_MAJOR}" -ge 20 ] 2>/dev/null; then
    ok "node $(node -v) (>=20 required)"
  else
    err "node $(node -v) is too old. Install Node.js 20+ from https://nodejs.org or via nvm: \`nvm install 20 && nvm use 20\`"
    FAIL=1
  fi
else
  err "node not found. Install Node.js 20+ from https://nodejs.org or via nvm: \`nvm install 20\`"
  FAIL=1
fi

require_cmd npm  "Bundled with Node.js — reinstall Node.js." || FAIL=1
require_cmd git  "Install from https://git-scm.com or via \`brew install git\`." || FAIL=1

ensure_github_cli || FAIL=1
ensure_ffmpeg_bin || FAIL=1

if [ "${FAIL}" -ne 0 ]; then
  err "One or more required tools are missing. Fix the errors above and re-run this script."
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Node dependencies
# ─────────────────────────────────────────────────────────────────────────────
heading "Installing Node dependencies"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  info "node_modules already present — running \`npm install\` to refresh."
else
  info "Fetching dependencies (this usually takes 1–3 minutes the first time)."
fi

npm install --no-audit --no-fund
ok "npm install complete"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Local .env
# ─────────────────────────────────────────────────────────────────────────────
heading "Setting up .env"

NEW_ENV_CREATED=0
if [ -f ".env" ]; then
  ok ".env already exists — leaving it untouched."
else
  NEW_ENV_CREATED=1
  if [ -f ".env.example" ]; then
    cp .env.example .env
    ok "Created .env from .env.example"
  else
    cat > .env <<'ENV'
# Minimum keys — if you later obtain `.env.example` from the repo, replace this file with it.
# (Request API keys from a maintainer or provision your own Plaid sandbox.)
ANTHROPIC_API_KEY=
PLAID_ENV=sandbox
PLAID_CLIENT_ID=
PLAID_SANDBOX_SECRET=
PLAID_LINK_LIVE=true
ELEVENLABS_API_KEY=
PLAID_LINK_CUSTOMIZATION=
PLAID_LAYER_TEMPLATE_ID=
GLEAN_API_TOKEN=
GLEAN_INSTANCE=
PLAID_GHE_HOSTNAME=github.plaid.com
PLAID_DEMO_APPS_REPO=https://github.plaid.com/dmajetic/plaid-demo-apps
PIPE_AGENT_MODE=1
ENV
    ok "Created a minimal .env — fill in keys; prefer replacing with the repo's full .env.example when available."
  fi
fi

# Idempotently ensure PIPE_AGENT_MODE=1 is present so SEs running under
# Claude Code / Cursor get the agent-driven refinement loop by default
# (orchestrator pauses on a continue-gate after each failed build-qa, hands
# the agent a per-step task .md, no LLM rebuilds). Set to 0 in .env to opt
# out and fall back to the legacy LLM regen path.
if [ -f ".env" ]; then
  if grep -qE '^[[:space:]]*PIPE_AGENT_MODE[[:space:]]*=' .env; then
    ok ".env already declares PIPE_AGENT_MODE — leaving it untouched."
  else
    {
      echo ""
      echo "# Default refinement loop = agent-driven (set 0 to fall back to LLM regen)."
      echo "PIPE_AGENT_MODE=1"
    } >> .env
    ok "Added PIPE_AGENT_MODE=1 to .env (agent-driven refinement is the new default)."
  fi
fi

# Idempotently ensure RESEARCH_MODE=gapfill is present so SEs get fast,
# targeted research by default. Set to broad or deep in .env for wider Glean/Gong coverage.
if [ -f ".env" ]; then
  if grep -qE '^[[:space:]]*RESEARCH_MODE[[:space:]]*=' .env; then
    ok ".env already declares RESEARCH_MODE — leaving it untouched."
  else
    {
      echo ""
      echo "# Default research mode = gapfill (set broad or deep for full research.js \"full\" mode)."
      echo "RESEARCH_MODE=gapfill"
    } >> .env
    ok "Added RESEARCH_MODE=gapfill to .env (targeted research is the default)."
  fi
fi

if [ "${NEW_ENV_CREATED}" -eq 1 ]; then
  if [ "${NON_INTERACTIVE}" = true ]; then
    print_env_owner_message
  elif confirm "Paste pipeline secrets into .env now (Anthropic, Plaid sandbox, ElevenLabs)? (ENTER = skip — ask repo owner)" n; then
    if command -v python3 >/dev/null 2>&1; then
      prompt_optional_env_secrets
      ok "Updated .env — open the file to verify or add optional keys from .env.example."
    else
      warn "python3 not found — cannot paste secrets from this script. Edit .env manually."
      print_env_owner_message
    fi
  else
    print_env_owner_message
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3b. MCP npm packages (Glean + AskBill bridge)
# ─────────────────────────────────────────────────────────────────────────────
heading "Knowledge MCP packages (Glean + AskBill)"

if node "${REPO_ROOT}/scripts/setup/prefetch-mcp-packages.js"; then
  ok "MCP package prefetch finished (see log above if skipped)."
else
  warn "MCP prefetch script exited unexpectedly — first research run may download packages."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. GitHub Enterprise authentication
# ─────────────────────────────────────────────────────────────────────────────
heading "GitHub Enterprise authentication"

# Printed when `gh auth status` fails — helps first-time `gh` users who have
# never run `gh auth login` (or never authenticated against this host).
print_gh_first_time_help() {
  local host="$1"
  printf "\n"
  info "${BOLD}First time with GitHub CLI or this host?${RESET} \`gh auth login\` is interactive and safe:"
  info "  ${BOLD}1.${RESET} Install \`gh\` if needed: https://cli.github.com (macOS: \`brew install gh\`)."
  info "  ${BOLD}2.${RESET} When prompted for ${BOLD}account type${RESET}, choose ${BOLD}GitHub Enterprise Server${RESET} (not GitHub.com), unless you intentionally use github.com only."
  info "  ${BOLD}3.${RESET} ${BOLD}Hostname${RESET}: enter ${CYAN}${host}${RESET} (or set ${CYAN}PLAID_GHE_HOSTNAME${RESET} before this script so we target the right server)."
  info "  ${BOLD}4.${RESET} ${BOLD}Protocol${RESET}: pick ${BOLD}SSH${RESET} if you clone/publish with SSH URLs (\`git@...\`); pick HTTPS if you only use HTTPS remotes."
  info "  ${BOLD}5.${RESET} ${BOLD}Authenticate${RESET}: ${BOLD}Login with a web browser${RESET} is easiest. If the browser flow fails (VPN, headless), use ${BOLD}Paste an authentication token${RESET} and create a PAT on your GHE instance with \`repo\` scope."
  info "  ${BOLD}6.${RESET} Verify after: ${CYAN}gh auth status --hostname ${host}${RESET}"
  info "Full reference: ${DIM}https://cli.github.com/manual/gh_auth_login${RESET}"
  printf "\n"
}

# If the var isn't in the current shell env, peek at the user's rc files
# (added there once and persisted across sessions) so first-time setup
# from a non-sourced shell still works.
peek_export_in_rc() {
  local var_name="$1"
  local file
  for file in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile" "${HOME}/.config/fish/config.fish"; do
    [ -f "$file" ] || continue
    # Match: `export VAR=value` or `export VAR="value"` or fish's `set -gx VAR value`
    local line
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+|set[[:space:]]+-gx[[:space:]]+)?${var_name}[[:space:]=]" "$file" | grep -v '^[[:space:]]*#' | tail -1 || true)
    [ -z "$line" ] && continue
    # Extract whatever follows the first `=` or `set -gx VAR `; strip surrounding quotes.
    local val
    val=$(printf '%s\n' "$line" | sed -E "s/^[^=]*=//; s/^[[:space:]]*set[[:space:]]+-gx[[:space:]]+${var_name}[[:space:]]+//; s/^[\"']//; s/[\"'][[:space:]]*\$//")
    val=$(printf '%s' "$val" | sed -E "s/[[:space:]]+#.*\$//")
    if [ -n "$val" ]; then
      printf '%s' "$val"
      return 0
    fi
  done
  return 1
}

GHE_HOST="${PLAID_GHE_HOSTNAME:-}"
if [ -z "${GHE_HOST}" ]; then
  GHE_HOST=$(peek_export_in_rc "PLAID_GHE_HOSTNAME" || true)
  [ -n "${GHE_HOST}" ] && info "Picked up PLAID_GHE_HOSTNAME=${GHE_HOST} from your shell rc files."
fi
if [ -z "${GHE_HOST}" ]; then
  # Try to infer from `git remote` URL of the current repo. `remote.ghe.url`
  # takes priority since it's the conventional name we use during onboarding;
  # `remote.origin.url` is the fallback.
  GHE_HOST=$(git config --get remote.ghe.url 2>/dev/null | sed -E 's|.*@([^:/]+).*|\1|; s|https?://([^/]+).*|\1|' | head -1)
  if [ -z "${GHE_HOST}" ]; then
    GHE_HOST=$(git config --get remote.origin.url 2>/dev/null | sed -E 's|.*@([^:/]+).*|\1|; s|https?://([^/]+).*|\1|' | head -1)
  fi
fi
if [ -z "${GHE_HOST}" ] || [ "${GHE_HOST}" = "github.com" ]; then
  GHE_HOST="github.com"
  info "No GHE hostname detected — defaulting to github.com."
  info "Set PLAID_GHE_HOSTNAME=ghe.yourcompany.com in your shell or in ~/.zshrc before re-running to onboard against GHE."
fi

if gh auth status --hostname "${GHE_HOST}" >/dev/null 2>&1; then
  GH_LOGIN="$(gh api --hostname "${GHE_HOST}" user --jq .login 2>/dev/null || true)"
  ok "gh CLI is signed in to ${GHE_HOST} as ${GH_LOGIN:-<unknown>}"
else
  warn "Not signed in to ${GHE_HOST}."
  print_gh_first_time_help "${GHE_HOST}"
  if confirm "Run \`gh auth login --hostname ${GHE_HOST}\` now?" y; then
    gh auth login --hostname "${GHE_HOST}" || {
      err "\`gh auth login\` exited with an error."
      warn "Fix auth (browser or PAT), then run: gh auth status --hostname ${GHE_HOST}"
      warn "See: https://cli.github.com/manual/gh_auth_login"
    }
  else
    warn "Skipping gh auth. You will need it before \`pipe publish\` and \`pipe pull\` work end-to-end."
    info "When ready, run: gh auth login --hostname ${GHE_HOST}"
  fi
fi

info "${BOLD}Git pulls (code + demo repo):${RESET} \`gh auth login\` covers the GitHub CLI only. For \`npm run pipe -- pull\` you also need \`git\` access:"
info "  · SSH: add your public key to GHE → Settings → SSH keys; test: ${CYAN}ssh -T git@${GHE_HOST:-github.plaid.com}${RESET}"
info "  · HTTPS: set ${CYAN}PLAID_DEMO_APPS_REPO${RESET} to an https:// URL in .env and use a PAT when Git prompts."
info "  See README: GitHub authentication — pull updated code + shared demo repo."

# ─────────────────────────────────────────────────────────────────────────────
# 5. Identity cache
# ─────────────────────────────────────────────────────────────────────────────
heading "Resolving and caching identity"

if npm run --silent pipe -- whoami >/dev/null 2>&1; then
  WHO_OUT="$(npm run --silent pipe -- whoami 2>/dev/null || true)"
  GH_LOGIN_FROM_PIPE="$(printf "%s" "${WHO_OUT}" | awk -F: '/Login:/{gsub(/[[:space:]]*/,"",$2); print $2; exit}')"
  if [ -n "${GH_LOGIN_FROM_PIPE}" ]; then
    ok "Identity resolved: ${GH_LOGIN_FROM_PIPE} (cached at ~/.plaid-demo-recorder/identity.json)"
  else
    warn "pipe whoami did not return a login. Re-run \`npm run pipe -- whoami\` after fixing gh auth."
  fi
else
  warn "Could not run \`pipe whoami\`. After gh auth is set up, run: npm run pipe -- whoami"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Artifact repo clone
# ─────────────────────────────────────────────────────────────────────────────
heading "Artifact repo (published demo apps)"

ARTIFACT_DIR="${PLAID_DEMO_APPS_DIR:-${HOME}/.plaid-demo-apps}"
ARTIFACT_REPO="${PLAID_DEMO_APPS_REPO:-}"
if [ -z "${ARTIFACT_REPO}" ]; then
  ARTIFACT_REPO=$(peek_export_in_rc "PLAID_DEMO_APPS_REPO" || true)
  [ -n "${ARTIFACT_REPO}" ] && info "Picked up PLAID_DEMO_APPS_REPO=${ARTIFACT_REPO} from your shell rc files."
fi

if [ -z "${ARTIFACT_REPO}" ]; then
  warn "PLAID_DEMO_APPS_REPO is unset — skipping artifact clone."
  info "Ask a maintainer for the SSH/HTTPS URL, then export it in your shell:"
  info "  export PLAID_DEMO_APPS_REPO=git@${GHE_HOST}:<owner>/plaid-demo-apps.git"
  info "  export PLAID_DEMO_APPS_DIR=${ARTIFACT_DIR}   # optional"
  info "Then run: npm run pipe -- pull"
else
  if [ -d "${ARTIFACT_DIR}/.git" ]; then
    info "Artifact repo already cloned at ${ARTIFACT_DIR} — running \`git pull --ff-only\`."
    ( cd "${ARTIFACT_DIR}" && git pull --ff-only ) || warn "Pull failed — resolve manually or re-clone."
  else
    info "Cloning ${ARTIFACT_REPO} → ${ARTIFACT_DIR}"
    git clone "${ARTIFACT_REPO}" "${ARTIFACT_DIR}"
  fi
  ok "Artifact repo ready at ${ARTIFACT_DIR}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7. Playwright browser (needed for recording)
# ─────────────────────────────────────────────────────────────────────────────
heading "Playwright browser"

if node -e "require.resolve('playwright')" >/dev/null 2>&1; then
  info "Ensuring Chromium is installed for Playwright (idempotent)."
  # BOTH variants: `chromium` (record) and `chromium-headless-shell` (build-qa's
  # headless visual capture + plaid-link-qa + brand screenshots). Without the
  # headless-shell, build-qa silently degrades to token-only — no visual score
  # (observed on a first-time build, Astera 2026-06-30).
  npx --yes playwright install chromium chromium-headless-shell \
    || warn "playwright install failed — rerun \`npx playwright install chromium chromium-headless-shell\` later."
  ok "Playwright Chromium + headless-shell ready"
else
  warn "playwright package not found — this should have been installed by \`npm install\`. build-qa's visual score and \`record\` need it: run \`npm install\` then \`npx playwright install chromium chromium-headless-shell\`."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 7b. Render engine — vidmagik-mcp (MoviePy MCP server) for full-pipeline video.
#     Optional + graceful: app-only builds (`npm run demo`) don't render, and a
#     failed setup only means render falls back to Remotion. --skip-render-engine
#     (or SKIP_RENDER_ENGINE=true) to skip.
# ─────────────────────────────────────────────────────────────────────────────
heading "Render engine (vidmagik-mcp — for full-pipeline video)"
setup_render_engine || true

# ─────────────────────────────────────────────────────────────────────────────
# 8. First-run quick start
# ─────────────────────────────────────────────────────────────────────────────
heading "All set — here's how to build your first demo"

cat <<EOF

  ${BOLD}Get up and running (read README.md section “Get up and running quickly”):${RESET}
    1. ${CYAN}npm run quickstart${RESET}  — in your normal terminal; wizard writes
                              inputs/prompt.txt + inputs/quickstart-research-task.md
                              + inputs/quickstart-agent-bootstrap.txt
    2. Open this repo in ${CYAN}Claude Code${RESET} (Agent mode).
    3. Paste ${CYAN}inputs/quickstart-agent-bootstrap.txt${RESET} as the first Agent message
       (or open ${CYAN}inputs/quickstart-research-task.md${RESET} → “run this task end-to-end”).
    4. Agent runs AskBill + Glean, updates prompt.txt, then ${CYAN}npm run demo${RESET} (build-qa)
       when the task says to — not ${CYAN}npm run pipe -- new --app-only${RESET}.
    5. Second terminal: ${CYAN}npm run dashboard${RESET} → http://localhost:4040
    6. Optional third terminal: ${CYAN}npm run pipe:status-loop${RESET} — prints ${CYAN}pipe status${RESET} every 300s (${CYAN}PIPE_STATUS_INTERVAL_SEC${RESET} to change). Agents: follow ${CYAN}CLAUDE.md${RESET} heartbeat + ${CYAN}.cursor/rules/pipeline-heartbeat.mdc${RESET}.
    7. ${CYAN}npm run pipe -- publish <run-id>${RESET}  (optional — share your demo)

  ${BOLD}Alternative A — Agent-only one-shot (no terminal quickstart):${RESET}
    Stay in ${CYAN}Cursor / Claude Code${RESET} Agent mode; paste the message in
    ${CYAN}inputs/agent-one-shot-app-only-message.example.txt${RESET} (edit scenario).
    Agent fills ${CYAN}inputs/prompt.txt${RESET} from the template, then ${CYAN}npm run demo${RESET}.
    Details: README → “Agent-only one-shot”.
  ${BOLD}Alternative B — hand-written prompt + CLI:${RESET}
    1. ${CYAN}Edit inputs/prompt.txt${RESET} (template at inputs/prompt-template-app-only.txt).
    2. ${CYAN}npm run pipe -- new --app-only --non-interactive${RESET}
    3. ${CYAN}npm run dashboard${RESET}     — http://localhost:4040 for live visibility.

  ${BOLD}When the pipeline pauses on a continue-gate (default behavior):${RESET}
    The orchestrator prints a path to a task .md (prompt-fidelity, data-realism,
    script-coherence, qa-touchup, or story-echo). Open it in your AI agent in
    ${CYAN}Agent mode${RESET}, the agent makes targeted edits, then run:
      ${CYAN}npm run pipe -- continue <run-id>${RESET}   — releases the orchestrator.
    Loop max 5 iterations or until QA passes (88+). No LLM full rebuilds.

  ${BOLD}Monitor an in-flight run:${RESET}
    ${CYAN}npm run pipe -- status${RESET}       — snapshot of every stage
    ${CYAN}npm run pipe -- logs --follow${RESET} — tail the live output
    ${CYAN}npm run pipe:status-loop${RESET}     — status every 300s (${CYAN}PIPE_STATUS_INTERVAL_SEC${RESET})

  ${BOLD}Pull the latest shared demos:${RESET}
    ${CYAN}npm run pipe -- pull${RESET}         — git pull this repo AND plaid-demo-apps

  ${BOLD}Docs:${RESET}
    · ${DIM}README.md${RESET}                          — setup + workflow primer
    · ${DIM}docs/distribution-architecture.md${RESET}  — two-repo distribution model details
    · ${DIM}CLAUDE.md${RESET}                          — pipeline architecture + stage list
    · ${DIM}.cursor/rules/pipeline-heartbeat.mdc${RESET} — agent heartbeat + non-interactive hints
    · ${DIM}.claude/skills/pipeline-cli/SKILL.md${RESET} — agent-facing CLI reference

${GREEN}Done.${RESET}
EOF
