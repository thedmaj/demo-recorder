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
#      prompts to paste secrets (default: skip) with guidance to ask the repo owner.
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
for arg in "$@"; do
  case "$arg" in
    --non-interactive|--ci) NON_INTERACTIVE=true ;;
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

# Idempotently ensure RESEARCH_MODE=broad is present so SEs get deeper
# research by default (more Glean breadth, more Gong color, more grounded
# sample data). Set to gapfill in .env to opt back into the shallow default.
if [ -f ".env" ]; then
  if grep -qE '^[[:space:]]*RESEARCH_MODE[[:space:]]*=' .env; then
    ok ".env already declares RESEARCH_MODE — leaving it untouched."
  else
    {
      echo ""
      echo "# Default research mode = broad (set gapfill for the shallow legacy default)."
      echo "RESEARCH_MODE=broad"
    } >> .env
    ok "Added RESEARCH_MODE=broad to .env (deeper research is the new default)."
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
  npx --yes playwright install chromium || warn "playwright install failed — rerun \`npx playwright install chromium\` later."
  ok "Playwright Chromium ready"
else
  warn "playwright package not found — this should have been installed by \`npm install\`."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 8. First-run quick start
# ─────────────────────────────────────────────────────────────────────────────
heading "All set — here's how to build your first demo"

cat <<EOF

  ${BOLD}Recommended path — guided wizard (your first demo):${RESET}
    1. ${CYAN}npm run quickstart${RESET}    — asks brand / persona / products / use-case;
                              writes inputs/prompt.txt + a research task md
    2. Open the printed ${CYAN}inputs/quickstart-research-task.md${RESET} in
       ${CYAN}Cursor or Claude Code (Agent mode)${RESET} and say "Run this task."
       The agent runs AskBill + Glean to enrich the prompt, then kicks off
       the full pipeline.
    3. ${CYAN}npm run dashboard${RESET}     — http://localhost:4040 for live visibility.
    4. ${CYAN}npm run pipe -- publish <run-id>${RESET}  (optional — share your demo)

  ${BOLD}Alternative — hand-written prompt:${RESET}
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

  ${BOLD}Pull the latest shared demos:${RESET}
    ${CYAN}npm run pipe -- pull${RESET}         — git pull this repo AND plaid-demo-apps

  ${BOLD}Docs:${RESET}
    · ${DIM}README.md${RESET}                          — setup + workflow primer
    · ${DIM}docs/distribution-architecture.md${RESET}  — two-repo distribution model details
    · ${DIM}CLAUDE.md${RESET}                          — pipeline architecture + stage list
    · ${DIM}.claude/skills/pipeline-cli/SKILL.md${RESET} — agent-facing CLI reference

${GREEN}Done.${RESET}
EOF
