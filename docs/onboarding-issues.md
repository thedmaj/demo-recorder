# Manual-download (ZIP) install — field feedback & resolutions

Source: a fresh-macOS (Apple Silicon) Option B (ZIP) install session, GHE
intentionally skipped, agent-driven per ONBOARDING.md (reported 2026-07-09).
**Important context:** the tested ZIP was an OLD snapshot (committed
`.mcp.json`, no `.mcp.json.template`, none of the manual-install work). Every
item below is addressed in the current tree; statuses reference where.
Re-export the shared Google Drive ZIP after these changes land so Option B
users actually receive them.

## 🔴 Blockers

### 1. GHE steps derailed the tail of install.sh (Playwright/MCP never ran)
**Root causes:** GHE auth/identity/artifact-clone were sequenced *before*
Playwright + MCP under `set -euo pipefail`; `gh auth login` (interactive)
fired even in `--non-interactive`; the artifact `git clone` was unguarded, so
a failure aborted the script.
**Resolved in `scripts/setup/install.sh`:**
- GitHub steps are auto-skipped when there's no `.git` dir (`SKIP_GITHUB=auto`;
  force with `--skip-github` / `SKIP_GITHUB=true|false`).
- The GHE sections were **moved to the end** (steps 7d/7e/7f) — Playwright,
  render engine, and MCP setup always complete first.
- `gh auth login` is never launched in `--non-interactive` mode (prints the
  command to run instead).
- The artifact-repo `git clone` is guarded (`|| warn`), so a failed clone
  can't abort the installer.

### 2. AskBill venv fails — `mcp` needs Python ≥3.10, stock macOS is 3.9.6
**Resolved in `scripts/setup/install.sh` and the standalone askbill installer:**
- `pick_python3()` selects the newest interpreter ≥3.10 (`python3.13` →
  `python3.10`, then bare `python3`) for all venv creation.
- `ensure_python3` requires ≥3.10 and brew-installs `python@3.12` when absent.
- `verify_askbill_mcp` **rebuilds** an existing venv whose python is <3.10
  (the state a stock-python first attempt leaves behind).
- Docs updated: python **3.10+** everywhere (ONBOARDING §2, installer README).

### 3. AskBill not wired by the documented path; the `wss://` shortcut is a trap
**a. Doc ≠ mechanism (`.mcp.json.template` missing from the ZIP):** the tested
ZIP predated the template. The current tree tracks `.mcp.json.template` and
gitignores `.mcp.json` — the docs and mechanism now agree. *(Action: refresh
the distributed ZIP.)*
**b. AskBill server not pre-installed / discovery was luck:** the server is
now **vendored in-repo** at `scripts/setup/mcp-servers/askbill-plaid/` and
`install.sh` (step 7c) auto-provisions `~/plaid-mcp-servers/askbill-plaid/`
from it (copy → venv → `pip install mcp websockets` → import smoke test). No
separate installer or out-of-band step.
**c. `ASKBILL_API_URL=wss://hello-finn…` hangs via mcp-remote:** that endpoint
speaks AskBill's native websocket protocol, **not MCP** — mcp-remote can never
handshake. Fixed on both sides: `.env.example` no longer suggests a `wss://`
value and documents "local Python bridge only"; `mcp-clients.js`
(`buildAskBillMcpCommand`) explicitly refuses to bridge a hello-finn URL with
a clear warning instead of hanging.

## 🟠 High

### 4. `playwright install chromium chromium-headless-shell` hangs after the first browser
**Resolved in `install.sh` step 7:** the two browsers install in **separate
invocations**; the repo's pinned `./node_modules/.bin/playwright` is preferred
over `npx --yes`; each invocation is `|| warn`-guarded with a retry hint; the
step prints a "large download, can look idle" note.

## 🟡 Medium

### 5. A real `.env` saved as `env` (no dot) silently loses to the template
**Resolved:** `install.sh` §3 now warns when `.env` is byte-identical to
`.env.example` and detects stray `env` / `env.txt` / `.env.txt` files with a
`mv` hint. The ONBOARDING §5 / bootstrap verify snippets now check
"not-still-the-template" + "key isn't the `sk-ant...` placeholder", not just
non-empty, and both call out the exact-name requirement.

### 6. Node not installed by install.sh; Homebrew present but off-PATH
**Resolved:** `ensure_node20` offers `brew install node` (bootstrapping
Homebrew first if needed — the official installer also sets up the Xcode
Command Line Tools); `refresh_brew_env` picks up an existing
`/opt/homebrew`/`/usr/local` brew that isn't on the current shell's PATH.
ONBOARDING §2 is now prescriptive (`brew install node git ffmpeg python@3.12`)
and notes the installer can do all of it.

## 🟢 Low / doc polish

- "install verifies AskBill" is now literally true — step 7c provisions it
  from the vendored copy, then verifies.
- `gh` is no longer brew-installed on the ZIP/no-GHE path (`ensure_github_cli`
  only runs when GitHub steps are active).
- ONBOARDING §6 states plainly: AskBill = local Python bridge (3.10+),
  Glean / Solutions Master = env-driven npm (no local server), moviepy =
  render-only, playwright = `npx @playwright/mcp`, figma = remote HTTP.
