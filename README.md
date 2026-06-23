# Plaid Demo Recorder

Generate hyper-realistic Plaid customer demo **apps** — host banking UI with a real Plaid Link integration — entirely from a single `inputs/prompt.txt`. Publish finished demos to a shared catalog your Sales Engineering teammates can pull and launch locally. (Full-pipeline recording + voiceover + MP4 render is under active stabilization and intentionally not part of this README yet.)

This README is scoped to **install → first demo**. For pipeline architecture, see [`CLAUDE.md`](CLAUDE.md). AI agents supervising builds follow [`AGENTS.md`](AGENTS.md) and the [heartbeat rule](.cursor/rules/pipeline-heartbeat.mdc). Distribution / publish details live in [`docs/distribution-architecture.md`](docs/distribution-architecture.md).

---

## 1. Install (line by line)

**macOS only.** These steps use [Homebrew](https://brew.sh) — install it from <https://brew.sh> if `brew --version` fails.

```bash
# 1. Node 20+
node -v        # if missing or <20: `nvm install 20 && nvm use 20`

# 2. Git, GitHub CLI, ffmpeg
brew install git gh ffmpeg

# 3. Authenticate `gh` to GitHub Enterprise (required to clone the private repos)
gh auth login --hostname github.plaid.com
# Pick: GitHub Enterprise Server → hostname github.plaid.com → HTTPS (simpler) or SSH → browser login.
# If the browser flow fails, pick "Paste an authentication token" and create a PAT with `repo` scope.

gh auth status --hostname github.plaid.com    # verify

# 4. Clone this repo (HTTPS — gh will supply credentials when git prompts)
git clone https://github.plaid.com/dmajetic/plaid-demo-recorder.git
cd plaid-demo-recorder
# SSH alternative if you already have keys on GHE:
#   git clone git@github.plaid.com:dmajetic/plaid-demo-recorder.git

# 5. Run the project installer
bash scripts/setup/install.sh
# Creates .env, runs `npm install`, prefetches MCP packages, clones ~/.plaid-demo-apps,
# installs Playwright Chromium. Skip the "paste secrets" prompt — you will get real
# values from the repo owner in step 2.

# 6. Verify
npm run pipe -- whoami
```

`scripts/setup/install.sh` is idempotent — rerun any time to refresh dependencies. Add `--non-interactive` for CI / unattended setup.

---

## 2. Get secrets from the repository owner (required)

The installer cannot give you working secrets. Before a first build, **message the repo owner** (or the maintainer who invited you) and ask for the two artifacts below.

### 2a. The `.env` file

The owner will send you a completed `.env` with the sandbox credentials and API keys the pipeline needs (`ANTHROPIC_API_KEY`, `PLAID_CLIENT_ID`, `PLAID_SANDBOX_SECRET`, `ELEVENLABS_API_KEY`, etc.). Save it at the repo root, **replacing** the template that `install.sh` wrote:

```bash
mv ~/Downloads/plaid-demo-recorder.env  ./.env
```

**Never commit `.env`.** It is `.gitignore`d. The structure is documented in [`.env.example`](.env.example).

### 2b. Google embeddings — no service-account JSON needed

The embedding stages (`embed-script-validate`, `embed-sync`) use **`gemini-embedding-2` via the Gemini API with `GOOGLE_API_KEY`** (already in the `.env` from the owner) — there is **no GCP service-account JSON / ADC** to download or configure. Without `GOOGLE_API_KEY`, those stages fall back to Anthropic Haiku / skip; builds still complete.

Sanity-check after placing `.env`:

```bash
npm run pipe -- validate-env
```
Expect `[env-check] ✓ Required checks passed`.

> If you also need **Glean** / **AskBill** MCP integrations for internal research, those values are in `.env` too and come from the same owner handoff. Without them, research returns `[Glean unavailable]` / `[AskBill unavailable]` — builds still complete, just with less customer color.

---

## 3. Quickstart — run the pipeline (Path A: terminal wizard)

Easiest way to a first demo. Runs in any macOS terminal (macOS Terminal, iTerm, etc.).

```bash
npm run quickstart
```

The wizard asks for brand, industry, Plaid Link mode (modal / embedded), products, persona, and a one-sentence pitch. It writes three files into `inputs/`:

- `inputs/prompt.txt` — draft prompt filled from [`inputs/prompt-template-app-only.txt`](inputs/prompt-template-app-only.txt).
- `inputs/quickstart-research-task.md` — agent task that runs AskBill + Glean and refines the prompt.
- `inputs/quickstart-agent-bootstrap.txt` — paste-first message for Claude Code / Cursor Agent mode.

**Then kick off the build.** App-only is the only supported mode right now — full-pipeline (recording + MP4 + pptx) is being stabilized and intentionally not documented yet.

```bash
# App-only, stops at build-qa (fast iteration, no recording / render).
npm run demo
```

In a second terminal, open the dashboard for live visibility of stages and QA scores:

```bash
npm run dashboard           # http://localhost:4040
```

The wizard defaults research to `gapfill` (targeted AskBill + 0–2 Glean calls). For broader research (full Glean/Gong pass), use `RESEARCH_MODE=broad npm run demo` or `npm run pipe -- new --research=broad`.

---

## 4. Alternative quickstart — run directly from Agent mode (Path B)

Skip `npm run quickstart` and drive the whole build from **Claude Code in Agent mode**.

**"Agent mode" means you launch Claude Code from the folder where this app is installed.** From the same Terminal where you ran the installer:

```bash
cd ~/plaid-demo-recorder      # or wherever you cloned the repo
claude                        # runs Claude Code in the current folder
```

`claude` opens Claude Code scoped to the current directory — that's what makes it Agent mode. (Cursor users: open the repo folder in Cursor and toggle the **Agent** pill on the chat; same idea.) Chat-only mode **cannot** run `npm run demo` for you; Agent mode can.

Once Claude Code is open, paste the simple prompt below as your **first message**, edit the scenario fields to match your demo, and send. The agent will write `inputs/prompt.txt` from the template, then run `npm run demo` and handle any continue-gates.

### Agent-mode prompt (copy, edit the scenario, paste)

```text
Use `inputs/prompt-template-app-only.txt` to write `inputs/prompt.txt` for a simple
app-only Plaid demo (no slides). Then run `npm run demo` in the integrated terminal.
If a continue-gate fires, open the task .md it points to, make the edits it asks for,
and run `npm run pipe -- continue <run-id>`.

Scenario (edit me):
- Brand / host app: Chime (chime.com)
- Plaid product: Plaid Auth, standard (modal) Plaid Link
- Persona: Jordan, a new Chime customer
- Story / use case: Jordan links an external checking account so he can transfer funds in
- Value prop: faster, safer bank linking — verified account and routing numbers in seconds
- Research depth: gapfill
```

That's the minimum needed for a clean build: **brand, product, persona, story/use case, value prop**. A longer ready-to-paste version (Airbnb host scenario, dual value props) lives in [`inputs/agent-one-shot-app-only-message.example.txt`](inputs/agent-one-shot-app-only-message.example.txt).

### What your prompt must contain for a clean build

| Requirement | Why it matters |
|-------------|----------------|
| Brand + optional URL (e.g. `airbnb.com`) | Feeds `brand-extract`: realistic nav/footer + regulated copy. |
| **Approved** Plaid product names (Plaid Auth, Plaid Identity Match, Plaid Signal, Plaid Assets, IDV, Layer, Monitor) | Anything else breaks product-KB lookup and QA. |
| Plaid Link mode: **modal (standard)** or **embedded** | Build + Playwright contracts differ. |
| Persona (named user + role) | Keeps script, sample data, and narration coherent. |
| Use case in plain language | Drives `demo-script.json` steps. |
| Value for the end user and (if relevant) the platform | Aligns storyboard and "why Plaid" beats. |
| Storyboard beats (host / link / insight only — **no slide beats**) | App-only pipeline expects non-slide scene types. |
| Optional `Research depth:` line (`gapfill`, `broad`, `messaging`, `skip`) | Overrides the default. |

Miss one and the pipeline will still run, but expect generic copy or a `continue-gate` pause from `prompt-fidelity-check`, `data-realism-check`, or `build-qa`.

---

## 5. What happens during a run

With `PIPE_AGENT_MODE=1` (the installer default), every quality gate pauses on a **continue-gate** so an AI agent can fix problems before downstream stages run:

```
[Orchestrator] prompt-fidelity-check found 1 critical drift(s) (score 80/100). Pausing for agent fix.
[Orchestrator]   task: out/demos/<run-id>/prompt-fidelity-task.md
[Orchestrator]   then run: npm run pipe -- continue <run-id>
```

When that fires, open the task `.md` in Agent mode and say **"Run this task"**. The agent edits exactly the failing piece with `Read` + `StrReplace`, then you run:

```bash
npm run pipe -- continue <run-id>
```

to release the orchestrator. Loop max **5 iterations** or until QA ≥ 88. The same flow runs for `data-realism-check`, `embed-script-validate`, brand-fidelity inside `build-qa`, and `story-echo-check`. No LLM full-file regeneration — edits are surgical.

**Heartbeat (agents only):** while a run is active, AI agents must post a short chat update every ~5 min summarizing `pipe status`. See [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc) and [`AGENTS.md`](AGENTS.md).

---

## 6. Everyday commands

```bash
npm run pipe -- pull                     # latest code + shared demos (~/.plaid-demo-apps)
npm run quickstart                       # wizard-driven app-only build
npm run demo                             # app-only, stop at build-qa (only supported mode today)
npm run pipe -- new --app-only           # alternative: build from a hand-written prompt.txt
npm run pipe -- status                   # where is my run?
npm run pipe -- resume <run-id> --from=<stage>
npm run pipe -- stage <stage> <run-id>   # re-run one stage in place
npm run pipe -- continue <run-id>        # release a continue-gate after agent edits
npm run pipe -- qa-touchup <run-id>      # generate on-demand qa-touchup-task.md
npm run pipe -- publish <run-id>         # share demo to ~/.plaid-demo-apps + PR
```

`npm run pipe -- pull` runs `git pull --ff-only` in this repo **and** syncs `~/.plaid-demo-apps`. Requires `gh` login + SSH or HTTPS credentials for Git on both repos.

---

## 7. Environment variables (quick reference)

Secrets and paths live in `.env`. Most come from the owner handoff in §2.

| Key | Required? | Notes |
|-----|-----------|-------|
| `ANTHROPIC_API_KEY` | **yes** | Every LLM call. |
| `PLAID_CLIENT_ID` / `PLAID_SANDBOX_SECRET` | **yes** | Plaid sandbox. |
| `PLAID_ENV` | yes | Keep `sandbox` unless you have an approved live scenario. |
| `PLAID_LINK_LIVE` | yes | `true` enables the real Plaid Link SDK. |
| `ELEVENLABS_API_KEY` | yes | Voiceover. |
| `GOOGLE_API_KEY` | optional | Gemini API key for `gemini-embedding-2` embeddings (embed-script-validate, embed-sync). No service-account JSON needed; without it those stages fall back to Haiku / skip. |
| `GLEAN_API_TOKEN` + `GLEAN_INSTANCE` | optional | Enables Glean MCP; without them, research returns `[Glean unavailable]`. |
| `ASKBILL_MCP_COMMAND` / `ASKBILL_API_URL` | optional | Enables AskBill MCP; same fallback behavior. |
| `PLAID_GHE_HOSTNAME` | yes for GHE auth | `github.plaid.com`. |
| `PLAID_DEMO_APPS_REPO` | yes for publish / pull | Artifact repo URL (HTTPS or SSH). |
| `RESEARCH_MODE` | optional | Default `gapfill`. Set to `broad` / `deep` for fuller Glean/Gong research. |
| `PIPE_AGENT_MODE` | installed default `1` | Pauses on continue-gates for agent fix-ups. Set `0` to fall back to the legacy LLM regen. |

Full list (plus optional flags) in [`.env.example`](.env.example).

---

## 8. Dashboard tabs

| Tab | What it's for |
|-----|---------------|
| Overview | Current run summary, product-knowledge status, recent builds. |
| Pipeline | Live stage badges, log viewer, CLI copy-to-clipboard. |
| Storyboard | Per-scene narration editor, scene timing, slide insert, timeline editor. |
| Demo Apps | Launch / preview every built or published demo. First Launch on a **Remote** demo copies the bundle into `out/demos/` so edits don't touch the shared clone. |
| Config | ~30 pipeline flags with hover tooltips. Secrets stay in `.env`. |
| Product Knowledge | `inputs/products/*.md` editor; value props auto-refresh when `last_vp_research` is >30 days old. |

---

## 9. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `node is too old` | `nvm install 20 && nvm use 20`. |
| `gh: command not found` or `ffmpeg: command not found` | `brew install gh ffmpeg`, then re-run `bash scripts/setup/install.sh`. |
| `npm run pipe -- validate-env` warns `GOOGLE_API_KEY is empty` | Optional — embeddings fall back to Haiku / skip. Add `GOOGLE_API_KEY` (from the owner's `.env`) to enable `gemini-embedding-2`. No service-account JSON is involved. |
| `dotenv loaded (0) variables from .env` when running in **Claude Code / Cursor Agent mode from a git worktree** | Cursor worktrees share `.git` with the main repo but don't carry gitignored files (`.env`). The pipeline now auto-detects worktrees and loads `.env` from the main repo via `scripts/scratch/utils/dotenv-loader.js`. If it still fails, set **`PLAID_DEMO_RECORDER_ENV=/absolute/path/to/main-repo/.env`** in the worktree shell or ask Claude Code to run commands from the main repo root (`cd /path/to/main && npm run demo`). |
| `pipe whoami` returns no login | `gh auth status --hostname github.plaid.com`; if not signed in, redo `gh auth login`. |
| `Permission denied (publickey)` cloning `plaid-demo-apps` | Add SSH key to GHE **Settings → SSH keys**, or switch `PLAID_DEMO_APPS_REPO` to HTTPS and supply a PAT when Git prompts. |
| Dashboard "Failed to launch: No built app found for run …" | Remote demo not yet staged locally. Click **Launch** again (it copies on first try), or `npm run pipe -- pull` to refresh the artifact clone. |
| `.env` missing after install | Installer skips existing `.env`. Delete yours and re-run `install.sh`, or copy `.env.example` to `.env` manually. |
| Glean / AskBill unavailable in research logs | Fill `GLEAN_INSTANCE` + `GLEAN_API_TOKEN` or `ASKBILL_*` per `.env.example`. Not fatal — builds still complete. |

---

## 10. Links

- Pipeline architecture + stage list → [`CLAUDE.md`](CLAUDE.md)
- Distribution + publish flow → [`docs/distribution-architecture.md`](docs/distribution-architecture.md)
- Agent CLI reference → [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md)
- Agent heartbeat rule → [`.cursor/rules/pipeline-heartbeat.mdc`](.cursor/rules/pipeline-heartbeat.mdc)
- Prompt authoring examples → [`docs/prompt-examples.md`](docs/prompt-examples.md)
- Full env reference → [`.env.example`](.env.example)
