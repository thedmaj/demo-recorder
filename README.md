# Plaid Demo Recorder

Generate hyper-realistic Plaid customer demos — host banking UI, Plaid Link integration, narration, and final MP4 — entirely from a single `inputs/prompt.txt`. Publish finished demos to a shared catalog your Sales Engineering teammates can pull and launch locally.

This README is written for a sales engineer onboarding to the tool for the first time. For the full pipeline architecture, see [`CLAUDE.md`](CLAUDE.md). For the GitHub-Enterprise distribution model, see [`docs/distribution-architecture.md`](docs/distribution-architecture.md).

---

## Get up and running quickly

Do this **after** [`bash scripts/setup/install.sh`](#one-command-install) and a filled **`.env`** (API keys). This is the shortest path to a working app-only demo:

| Step | Where | What you do |
|------|-------|-------------|
| **1** | **System terminal** — macOS Terminal, Windows Terminal, etc. — `cd` to this repo | Run **`npm run quickstart`** and complete the wizard. It writes **`inputs/prompt.txt`**, **`inputs/quickstart-research-task.md`**, and **`inputs/quickstart-agent-bootstrap.txt`** (paste-first hook for Agent mode). |
| **2** | **Claude Code** | Open **this folder as the project** in Claude Code (not just a loose file). Turn on **Agent mode** so the agent can run commands and edit files. |
| **3** | *(Recommended)* Claude Code | Open **`inputs/quickstart-agent-bootstrap.txt`**, copy all, and paste it as the **first** Agent message (or open **`inputs/quickstart-research-task.md`** and say **“Run this task end-to-end”**). That runs AskBill + Glean, refines the prompt, then runs **`npm run demo`** (build-qa) if you chose auto-build in the wizard. Skip only if you’re iterating on an already-enriched prompt. |
| **4** | **Claude Code integrated terminal** | Run **`npm run demo`**. This runs the pipeline through **build-qa** (fast iteration; no full MP4). Stay in Agent mode so QA continue-gates can be handled automatically. |

**Parallel:** in a **second terminal**, run **`npm run dashboard`** and open <http://localhost:4040> to watch stages and QA scores. Optionally in a **third terminal**, run **`npm run pipe:status-loop`** so **`npm run pipe -- status`** prints every five minutes (set **`PIPE_STATUS_INTERVAL_SEC`** to override). Agents should still post brief updates in chat per **`CLAUDE.md`** heartbeat rules.

**Ship video later:** when the app passes QA, run **`npm run demo:full`** for recording + render + MP4.

Details, sample wizard transcript, and QA-loop behavior → [Your first demo — start here](#your-first-demo--start-here).

---

## What this gets you

- A **guided wizard** (`npm run quickstart`) that turns a one-sentence pitch into a researched, polished demo — runs AskBill + Glean, generates the prompt, kicks off the pipeline.
- An **agent-mode default** (`npm run demo`) that stops at `build-qa` for fast iteration. When you're ready to ship the MP4, run `npm run demo:full` for the full pipeline through render.
- An **agent-driven QA loop** that pauses on each quality checkpoint so an AI agent (Cursor / Claude Code) makes surgical edits between stages. No manual hand-holding for the common drift cases.
- **Five quality gates** (story fidelity, sample-data realism, narration coherence, brand fidelity, whole-video story echo) that catch hyper-realism issues before they ship.
- A local dashboard at <http://localhost:4040> for editing prompts, watching builds, inspecting demo apps, and managing your shared library.
- A single CLI entry point — `npm run pipe` — for every lifecycle action (build, resume, stage retry, status, publish).
- A centralized library of demos any teammate has published, pullable in one command.
- An optional one-click publish of your own demo to the shared library.

You do **not** need to know git internals, Node internals, or the Plaid SDK to run or publish a demo. The installer handles the plumbing, and the wizard handles the prompt authoring.

---

## Prerequisites

Install **before** or **during** setup:

| Tool | Why | How |
|------|-----|-----|
| **Node.js 20+** + **npm** | Pipeline runtime | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| **git** | Clone / pull | [git-scm.com](https://git-scm.com) — macOS: `brew install git` |
| **GitHub CLI (`gh`)** | **Publish/pull** and optional identity via `gh api user` — **not** required to compile/run a local pipeline build | [cli.github.com](https://cli.github.com) — macOS/Linux with [Homebrew](https://brew.sh): `brew install gh` |
| **ffmpeg** | Recording + MP4 render (`npm run demo:full`) | [ffmpeg.org/download.html](https://ffmpeg.org/download.html) — macOS: `brew install ffmpeg`; Debian/Ubuntu: `sudo apt-get install ffmpeg` |

**Automatic installs:** If [Homebrew](https://brew.sh) (`brew`) is on your `PATH`, `bash scripts/setup/install.sh` **checks** for `gh` and `ffmpeg` and, when either is missing, **offers** to run `brew install gh` / `brew install ffmpeg` (defaults to **yes**). With `--non-interactive`, it runs those installs without prompting when Homebrew is present. If `brew` is not installed, the script exits with links and OS-specific commands so you can install manually.

### GitHub authentication — pull updated code + shared demo repo

To **`git pull` this codebase** and to **clone / pull `plaid-demo-apps`** (published demos), Git must authenticate to **GitHub Enterprise** the same way you would for any private repo. Do **not** rely on a ZIP download if you want updates — use a **git clone** of `plaid-demo-recorder`.

| What you need | Why |
|---------------|-----|
| **`gh auth login --hostname github.plaid.com`** | Unlocks **`gh`** (identity for `pipe publish`, **`gh pr create`**, and consistent hostname for `gh api user`). The installer walks you through this if you are not logged in. |
| **SSH *or* HTTPS credentials for `git`** | `npm run pipe -- pull` runs **`git pull`** in this repo and **`git fetch` / `git pull`** in `~/.plaid-demo-apps`. That uses **your SSH key** (if remotes are `git@...`) or **HTTPS + personal access token** (if remotes / `PLAID_DEMO_APPS_REPO` are `https://...`). **`gh` login alone does not replace `git` credentials** — if you see `Permission denied (publickey)`, add your SSH key to GHE (**Settings → SSH keys**) or switch **`PLAID_DEMO_APPS_REPO`** to HTTPS and use a PAT when Git prompts. |
| **Read access** on `plaid-demo-recorder`, **Read** on `plaid-demo-apps` | A maintainer must add you under **Settings → Collaborators** on both repos (see [Onboard a new sales engineer](#onboard-a-new-sales-engineer)). |

**Verify after setup:**

```bash
gh auth status --hostname github.plaid.com   # logged in to GHE
ssh -T git@github.plaid.com                  # SSH users — expect a success message, not "Permission denied"
npm run pipe -- whoami                       # resolved GHE login + paths
npm run pipe -- pull                         # updates this clone + ~/.plaid-demo-apps
```

More detail: [First time with GitHub or the GitHub CLI?](#first-time-with-github-or-the-github-cli); ZIP / SSH issues → [Troubleshooting the installer](#troubleshooting-the-installer).

---

## One-command install

From a fresh clone of this repo:

```bash
bash scripts/setup/install.sh
```

The script is idempotent — re-run it any time you want to refresh dependencies, browsers, or the shared artifact repo. It prompts before doing anything destructive.

What it does:

1. Checks `node` (≥20), `npm`, `git`, `gh` (GitHub CLI), and `ffmpeg`.
2. `npm install` — Node dependencies.
3. Creates `.env` from `.env.example` if missing. **Interactive installs** then ask whether to paste secrets (Anthropic, Plaid, ElevenLabs); **ENTER skips** with a reminder to ask your **repo owner** for keys. `--non-interactive` skips the prompt and prints the same reminder.
4. Prefetches **npm packages** for **Glean** (`@gleanwork/local-mcp-server`) and **AskBill** (`mcp-remote` when using a websocket URL) when `.env` has the matching variables — `scripts/setup/prefetch-mcp-packages.js`.
5. Verifies you're signed in to GitHub Enterprise via `gh auth status`; offers to run `gh auth login` if not.
6. Resolves and caches your GHE identity to `~/.plaid-demo-recorder/identity.json`.
7. Clones (or `git pull`s) the shared `plaid-demo-apps` artifact repo to `~/.plaid-demo-apps`.
8. Installs Playwright's Chromium browser for the recorder.
9. Prints the quick-start commands.

### First time with GitHub or the GitHub CLI?

If you have **never** signed in with [`gh`](https://cli.github.com) (or never to **your** GitHub Enterprise host), do this once before or during setup:

1. **Install the CLI** — Usually handled by `bash scripts/setup/install.sh` if Homebrew is installed (`brew install gh`). Otherwise: macOS `brew install gh`, or see [Installing gh](https://github.com/cli/cli#installation).
2. **Sign in to the right server** — For Plaid’s deployment, run `gh auth login --hostname github.plaid.com` *before* `bash scripts/setup/install.sh`, or answer **yes** when the installer offers to run it. If your company uses another GHE host, set `PLAID_GHE_HOSTNAME` first (see the env table below).
3. **Follow the prompts** — Choose **GitHub Enterprise Server** (not GitHub.com) when asked. Enter the **hostname** you were given (e.g. `github.plaid.com`). Pick **SSH** if you use `git@...` clone URLs; **HTTPS** if you only use HTTPS remotes. Prefer **Login with a web browser**; if that fails (VPN, SSO quirks), choose **Paste an authentication token** and create a **personal access token** on your GHE server with at least `repo` scope.
4. **Verify** — `gh auth status --hostname github.plaid.com` should show “Logged in to github.plaid.com”. Then `npm run pipe -- whoami` should print your login.

The installer also prints these hints automatically when you are not logged in. Full CLI reference: [`gh auth login`](https://cli.github.com/manual/gh_auth_login).

Run with `--non-interactive` for CI / unattended setup:

```bash
bash scripts/setup/install.sh --non-interactive
```

### Zip download, no git clone, or no GitHub authentication?

**Yes — you can run a pipeline build** (`npm run demo`, `npm run demo:full`, etc.) without authenticating to GitHub and without a `.git` directory (e.g. you unpacked a ZIP).

What actually matters for building:

- **Required:** Node.js 20+, `npm install`, and a filled-in **`.env`** (API keys from your repo owner). **`ffmpeg`** is required if you run stages that record or render video.
- **Not required for build:** `gh auth login`, remotes, or `git` history. The pipeline resolves **owner** metadata as: cached identity → `gh api user` → **`PLAID_DEMO_USER`** in `.env` → **null**. A **null owner** is fine — runs still write under `out/demos/<run-id>/`. Set `PLAID_DEMO_USER=your-handle` if you want owner labels in the dashboard without using `gh`.

What **does** need GitHub + `gh`: **`npm run pipe -- publish`**, **`npm run pipe -- pull`** on the **artifact** repo when **`PLAID_DEMO_APPS_REPO`** is set (shared demos), and the **`bash scripts/setup/install.sh`** path that clones `plaid-demo-apps`. **`pipe pull`** also runs **`git pull`** on **this** repo — that step **does nothing useful** if you installed from a **ZIP** (there is no `.git` folder); clone the repo instead if you want upstream code updates. If you skipped the full installer, run **`npm install`** (and **`npx playwright install chromium`**) yourself; install **`ffmpeg`** manually for full renders.

---

## Environment variables

Fill these in `.env` (the installer creates a template):

| Key | Required? | Notes |
|-----|-----------|-------|
| `ANTHROPIC_API_KEY` | **yes** | Drives every LLM call in the pipeline. |
| `PLAID_CLIENT_ID` | **yes** | Your Plaid sandbox `client_id`. |
| `PLAID_SANDBOX_SECRET` | **yes** | Plaid sandbox secret. **Never commit this.** |
| `PLAID_ENV` | yes | `sandbox` is strongly recommended — `production` is for sanctioned live demos only. |
| `PLAID_LINK_LIVE` | yes | `true` to use the real Plaid Link SDK in generated demos. |
| `ELEVENLABS_API_KEY` | yes | Voiceover narration. |
| `PLAID_LINK_CUSTOMIZATION` | optional | Plaid Link customization name (e.g. `ascend`). |
| `PLAID_LAYER_TEMPLATE_ID` | optional | Plaid Layer template ID for Layer demos. |
| `GLEAN_API_TOKEN` + **`GLEAN_INSTANCE`** + `GLEAN_INSTANCE_URL` | optional | **`GLEAN_INSTANCE`** (tenant short name, e.g. `plaid`) is required with the token for **`@gleanwork/local-mcp-server`** / `glean_chat`. URL used elsewhere — see `.env.example`. Unset → `[Glean unavailable]`. |
| `ASKBILL_MCP_COMMAND` / `ASKBILL_API_URL` | optional | Plaid docs (AskBill) via MCP or HTTP — see `.env.example`. WebSocket URLs use `npx -y mcp-remote`. Unset → `[AskBill unavailable]`. |
| `PLAID_DEMO_APPS_REPO` | required for publish / pull | Artifact repo URL. Default in `.env.example`: `https://github.plaid.com/dmajetic/plaid-demo-apps` (HTTPS + PAT avoids SSH setup). SSH: `git@github.plaid.com:dmajetic/plaid-demo-apps.git`. |
| `PLAID_GHE_HOSTNAME` | required for GHE auth | Current deployment: `github.plaid.com`. The installer uses this for `gh auth` and the identity resolver uses it to query the right `gh` host. |
| `PLAID_DEMO_USER` | optional | Override identity when `gh` is missing or not logged in — sets `run-manifest.json` owner without GitHub CLI (ZIP / offline builds). |

**All of these live in `.env`, which is `.gitignore`d.** The installer will never write real keys to disk from flags.

> Tip: The dashboard's **Config** tab exposes ~30 non-sensitive flags (build strategy, QA gates, research mode, Plaid Link QA behavior, etc.) with hover tooltips. Secrets still live in `.env` — you edit them in your shell, not in the dashboard.

### Glean and AskBill MCP — does the installer set these up?

The installer **does not** obtain tokens or run MCP servers as daemons. It **does**:

1. Create `.env` from **`.env.example`** or a minimal stub (including **`GLEAN_INSTANCE`**, **`ASKBILL_*`** placeholders).
2. After `.env` exists, run **`scripts/setup/prefetch-mcp-packages.js`**, which reads `.env` and, when configured, **`npm install`**s into a temp directory so **`@gleanwork/local-mcp-server`** (Glean) and **`mcp-remote`** (AskBill `wss://` bridges) land in the **npm cache**. That way `npx -y …` on the first research run hits the cache — matching how `mcp-clients.js` launches tools.

**Prefetch runs when:**

- **`GLEAN_API_TOKEN`** and **`GLEAN_INSTANCE`** are both non-empty → prefetch **`@gleanwork/local-mcp-server`**.
- **`ASKBILL_API_URL`** is a **`ws://` or `wss://`** URL, or **`ASKBILL_MCP_COMMAND`** mentions **`mcp-remote`** → prefetch **`mcp-remote`**.

If credentials are incomplete (e.g. token without **`GLEAN_INSTANCE`**), the script **warns** and skips the Glean prefetch until you align `.env` with [`mcp-clients.js`](scripts/scratch/utils/mcp-clients.js).

**If you leave integrations unset:** Research still runs (Anthropic + tools), but internal-knowledge calls return **`[Glean unavailable]`** or **`[AskBill unavailable]`** — **not** a hard failure; builds complete using `inputs/products/*.md` and your prompt.

**To enable:** Follow [`.env.example`](.env.example) — **`GLEAN_INSTANCE`** + **`GLEAN_API_TOKEN`** for Glean MCP, and **`ASKBILL_MCP_COMMAND`** and/or **`ASKBILL_API_URL`** for AskBill. Ask your maintainer for values.

---

## Everyday workflow

### Your first demo — start here

**Fast path:** follow **[Get up and running quickly](#get-up-and-running-quickly)** — **`npm run quickstart`** in a normal terminal → **Claude Code** (Agent mode) → paste **`inputs/quickstart-agent-bootstrap.txt`** (or **“Run this task”** on **`inputs/quickstart-research-task.md`**) → **`npm run demo`** in the integrated terminal when the task says to (not **`npm run pipe -- new --app-only`**, which runs the full orchestrator path).

The guided wizard writes a draft prompt + a research handoff; the agent enriches it, then the build runs.

```bash
npm run quickstart
```

#### Sample session

Press **ENTER** at any prompt to use the default in `[brackets]`. Annotated transcript of an actual run:

```text
╔══════════════════════════════════════════════════════════════════╗
║  Plaid Demo Pipeline — Quickstart Wizard (APP-ONLY BUILD)       ║
╚══════════════════════════════════════════════════════════════════╝

This wizard generates a draft inputs/prompt.txt from the app-only
template plus an agent task that runs AskBill + Glean research.

1) Customer / brand name (e.g. Bank of America): SoFi
2) Brand domain (e.g. bankofamerica.com) [optional]: sofi.com

3) Industry
   [1] Retail / consumer banking
   [2] Lending / consumer credit
   [3] Wealth / brokerage
   [4] Fintech / neobank
   ...
Choose [1]: 4

4) Plaid Link mode
   [1] Modal (default — Plaid Link opens in a popover)
   [2] Embedded (Link tile rendered in-page; iframe-launched)
Choose [1]: 1

5) Plaid products to feature (comma- or space-separated numbers)
   [ 1] Plaid Auth                         ACH account + routing verification
   [ 2] Plaid Identity Match               name / address / phone match scores
   [ 3] Plaid Signal                       ACH return-risk scoring (low score = low risk)
   [ 4] Plaid Transfer                     ACH money-movement orchestration
   [ 5] Plaid Transactions                 historical + recurring transaction sync
   [ 6] Plaid Liabilities                  student loans, mortgages, credit accounts
   [ 7] Plaid Assets                       balances + holdings via standard Link (not CRA)
   [ 8] Plaid Investments                  brokerage holdings + investment accounts
   [ 9] Plaid Investments Move             ACATS / POST /investments/auth/get transfers
   ... (Statements, CRA Base Report, Bank Income, Income Insights — full list in CLI)
Pick at least one (e.g. 1,2,3): 1,2,3

6) Persona (name + role, e.g. "Michael Carter, retail banking customer"): Maya Chen, SoFi Money customer

7) Use case — one-sentence pitch
   This is YOUR description of the demo. The agent will research around it.
> Maya is a new SoFi Money customer linking her external Chase account so she
  can fund a transfer in seconds, with Plaid Auth verifying the ACH rails,
  Identity Match confirming ownership, and Signal scoring the transfer's
  return risk before it leaves her account.

8) After research, auto-run `npm run demo` (build-qa) in Agent mode? [Y/n]: Y

Summary:
  Brand:           SoFi (sofi.com)
  Industry:        Fintech / neobank
  Plaid Link mode: modal
  Products:        Plaid Auth, Plaid Identity Match, Plaid Signal
  Persona:         Maya Chen, SoFi Money customer
  Use case:        Maya is a new SoFi Money customer linking her external...
  Research depth:  gapfill
  Build after:     yes
  Suggested run:   2026-04-29-sofi-fund-transfer-auth-identity-signal-v1

Write inputs/prompt.txt + research task? [Y/n]: Y

✓ Wrote inputs/prompt.txt              (previous version backed up)
✓ Wrote inputs/quickstart-research-task.md
✓ Wrote inputs/quickstart-agent-bootstrap.txt

Next (Agent mode — full auto):
  1. Open inputs/quickstart-agent-bootstrap.txt, copy all, paste as the first Agent message.
     (Or open inputs/quickstart-research-task.md and say: run this task end-to-end; then npm run demo.)
  2. Stay in Agent mode so AskBill + Glean MCP tools work.
  3. The agent runs research, updates inputs/prompt.txt, then runs npm run demo
     in the terminal (build-qa stop) if you said yes to step 8.
  4. Open http://localhost:4040 in another terminal with `npm run dashboard`
     for live visibility of stages, QA scores, and the agent-driven refinement loop.
```

The wizard does **not** ask for a research depth. It defaults to `gapfill` (the agent fills only what the prompt is missing) — the right answer for fast app-only iteration. If you later want broader research, pass **`--research=broad`** (or similar) to **`npm run demo`** / the orchestrator, not the quickstart handoff command.

#### After the wizard

Three files land in `inputs/`:

- **`inputs/prompt.txt`** — a draft pitch filled from the app-only template using your wizard answers. Already runnable, but the agent task below makes it richer.
- **`inputs/quickstart-research-task.md`** — the full Agent-mode checklist (AskBill + Glean + prompt rewrite + **`npm run demo`** when appropriate).
- **`inputs/quickstart-agent-bootstrap.txt`** — short paste-first message so the agent starts the full flow without extra prompting.

Open **`quickstart-agent-bootstrap.txt`** or **`quickstart-research-task.md`** in **Cursor or Claude Code (Agent mode)**. The agent:

1. Calls AskBill for product VPs (cached for 30 days in `inputs/products/*.md`).
2. Calls Glean for company context, Gong call snippets, and customer-facing positioning.
3. Edits `inputs/prompt.txt` in place to incorporate the findings.
4. Either kicks off `npm run demo` for you (if you said yes to "Build after"), or hands you back the keys to run it yourself.

From there the [agent-driven QA loop](#what-youll-see-when-the-pipeline-runs) takes over — gates pause for the agent to fix issues, the agent makes surgical edits, you run `npm run pipe -- continue <run-id>` to release.

> **Why `npm run demo` and not `npm run demo:full`?** `npm run demo` is the **agent-mode default** — it stops at `build-qa` so the loop produces a QA-graded host app without spending time on recording / voiceover / rendering. That matches how agents iterate. When you're ready to ship the actual MP4, run `npm run demo:full` (full pipeline through render).

If you already know what you want and don't need the wizard, jump to [Build a demo from a hand-written prompt](#build-a-demo-from-a-hand-written-prompt).

### What you'll see when the pipeline runs

Under the new default (`PIPE_AGENT_MODE=1`, set by `install.sh`), a run pauses on a **continue-gate** at each quality checkpoint so the agent can fix issues before downstream stages commit. You'll see logs like:

```
[Orchestrator] prompt-fidelity-check found 1 critical drift(s) (score 80/100). Pausing for agent fix.
[Orchestrator]   task: out/demos/<run-id>/prompt-fidelity-task.md
[Orchestrator]   then run: npm run pipe -- continue <run-id>
```

When that fires, open the task .md file in your AI agent (Cursor or Claude Code in Agent mode) and say "Run this task." The agent makes surgical edits — usually `Read` + `StrReplace` on `demo-script.json` or `scratch-app/index.html` — then you run `npm run pipe -- continue <run-id>` to release the orchestrator. It picks up where it left off, re-runs the gate, and either passes or pauses again. Loop max **5 iterations** or until QA threshold (88+) is hit.

This applies to every gate in the table below: prompt fidelity, sample-data realism, narration coherence, brand fidelity, and whole-video story echo.

### Build a demo from a hand-written prompt

For repeat builds where you've already authored `inputs/prompt.txt`:

1. Edit [`inputs/prompt.txt`](inputs/prompt.txt). Start from [`inputs/prompt-template-app-only.txt`](inputs/prompt-template-app-only.txt) if you want a blank structure — **that template is committed in this repo** so every clone has the same canonical app-only skeleton (copy it and customize). The richer reference with slide support is in [`docs/prompt-examples.md`](docs/prompt-examples.md).
2. Run:
   ```bash
   npm run pipe -- new --app-only --non-interactive
   ```
3. Open <http://localhost:4040> in another terminal with `npm run dashboard` for live visibility. The dashboard shows every stage, every QA score, and a per-card link to the prompt you used.
4. Watch the terminal — when a continue-gate fires, hand off to your AI agent (see [What you'll see](#what-youll-see-when-the-pipeline-runs) above) and run `pipe continue` to release.
5. When the run finishes, its demo app lives at `out/demos/<runId>/scratch-app/index.html`. The dashboard's "Demo Apps" tab can launch it in one click.

#### Pipeline anatomy — quality gates end-to-end

The default pipeline runs **five quality gates** at strategic points to catch story drift, sample-data realism issues, and whole-video coherence — each pauses on a continue-gate under `PIPE_AGENT_MODE=1` so the agent can fix things before downstream stages commit:

| When | Gate | What it catches | Output |
|---|---|---|---|
| After `script`, before `script-critique` | **`prompt-fidelity-check`** | Brand / persona / products / key amounts / Plaid Link mode in `prompt.txt` don't match `demo-script.json`. Three-tier story handling: respects user-written storyboards (verbatim), builds tailored arcs from scenario sentences (scenario-derived), or falls back to canonical (generic). | `prompt-fidelity-report.json` + `prompt-fidelity-task.md` |
| After `script-critique`, before `embed-script-validate` | **`data-realism-check`** | Generic placeholders (John Doe, example@example.com), too many round dollar amounts, persona income ↔ balance inconsistencies, masking-pattern drift, fake-looking transaction descriptions. Optional Haiku grader on top. | `data-realism-report.json` + `data-realism-task.md` |
| Between `script-critique` and `build` | **`embed-script-validate`** | Each step's narration disagrees with its `visualState`. Backed by Vertex / Google embeddings when available, with **Anthropic Haiku fallback** so the gate runs everywhere `ANTHROPIC_API_KEY` is set. | `script-validate-report.json` + `script-coherence-task.md` |
| Inside `build-qa` | **brand-fidelity sub-check** | Rendered host HTML is missing the verified nav labels or verbatim regulatory disclosures (FDIC notice, copyright, NMLS ID) for the brand. Pulled from `inputs/brand-references/<slug>.md` (curated) or auto-crawled. | Diagnostics in `build-qa-diagnostics.json` (categories: `brand-disclosure-missing`, `brand-nav-label-missing`) |
| After `voiceover`, before `coverage-check` | **`story-echo-check`** | Whole-video drift — Sonnet grades whether the concatenated voiceover, end-to-end, actually answers the user's `prompt.txt` pitch. Catches things per-step QA can't see (brand never mentioned, climactic reveal missing, persona swapped midway). | `story-echo-report.json` + `story-echo-task.md` |

In addition, the **agent-driven QA touchup loop** runs inside the build-qa refinement loop (default under `PIPE_AGENT_MODE=1`): on each failed iteration, the orchestrator hands the agent a per-step task .md (`qa-touchup-task.md`) and pauses for surgical edits — no LLM regen. Loop max 5 iterations or until QA passes (88+).

#### Three-tier story handling

The script generator picks one of three strategies based on what's in `prompt.txt`:

- **Verbatim** — when you write an explicit storyboard (numbered list ≥3 under a `## Storyboard` heading, or a markdown table with a `Beat` column), the LLM maps each of your beats to exactly one demo step, preserving order and step count. The canonical Plaid pitch arc is **not** applied.
- **Scenario-derived** — when you give a brand + ≥1 product + a clear use-case sentence (`**Use case:**` line, or any sentence ≥30 words mentioning the brand and a product), the LLM builds a custom storyboard tailored to YOUR scenario, using the canonical arc (problem → solution → reveal → outcome) as structural skeleton only.
- **Generic** — bare prompt with brand and products only → falls back to the canonical arc with generic content (today's behavior, the safety net).

#### Default research mode is now broad

`RESEARCH_MODE=broad` is the new install default (was `gapfill` — capped at 3-8 AskBill calls and 0-2 Glean calls). `broad` and `deep` map internally to research.js's `full` mode: more Glean breadth, more Gong color, more grounded sample data. Set `RESEARCH_MODE=gapfill` in `.env` to opt back into the shallow default.

#### What happens when QA fails (agent-driven refinement loop, default)

When `build-qa` flags issues, the pipeline's default refinement loop is **agent-driven** (set by `PIPE_AGENT_MODE=1` in `.env` — `install.sh` writes this for you). On each failed iteration:

1. The orchestrator generates `<run>/qa-touchup-task.md` listing the failing steps with their HTML blocks, Playwright rows, and frame paths.
2. It pauses on a continue-gate, emits a `::PIPE::qa_touchup_task_ready` event, and prints the path.
3. **You (or the AI agent driving the session in Claude Code / Cursor) open that file in Agent mode** — the agent makes surgical `StrReplace` edits to the failing steps only, then runs `npm run pipe -- continue <run-id>`.
4. The orchestrator wakes up, re-runs `build-qa`, and either passes the run or loops back to step 1. **Max 5 iterations** (default; was 3 prior to the hyper-realism upgrade), and **no LLM full-app regen at any point**.

Why default to this? It's roughly **5-10× cheaper in tokens, 3-5× faster** than the legacy LLM regen path, and regressions on unrelated steps are bounded by `StrReplace` scope rather than LLM prompt discipline. To opt out (and use the legacy LLM regen of the full `index.html`), set `PIPE_AGENT_MODE=0` in `.env` or pass `--build-fix-mode=touchup` (or `=fullbuild`) on a single run.

### Resume a failed run

```bash
npm run pipe -- status                              # see where it failed
npm run pipe -- resume <run-id> --from=<stage>      # pick up from that stage
npm run pipe -- stage <stage-name> <run-id>         # re-run one stage in place
```

### Fix a build that QA didn't like — agent-driven touchup (manual form)

The default build flow already pauses on a continue-gate and asks the agent to fix QA findings (see "Build a demo" above). If you've already finished a run, came back later, and want to invoke the same per-step fix flow on demand, run:

```bash
npm run pipe -- qa-touchup <run-id>     # alias: npm run qa-touchup <run-id>
```

This reads the latest QA report, picks the failing steps, and writes `<run>/qa-touchup-task.md` with each step's HTML block, Playwright row, and frame paths embedded. Open it in **Cursor or Claude Code (Agent mode)** and say "Run this task." The agent edits exactly the failing steps using `Read` + `StrReplace`, then you re-verify with `pipe stage build-qa <run-id>`.

The standalone form differs from the orchestrator-driven default in one place: it includes a **STOP and recommend `pipe stage build`** escalation block when QA flags structural issues (>=3 distinct failing steps, shared-chrome categories, or deterministic-blocker gate). The orchestrator-driven default suppresses that block (per "no rebuilds, agent makes iterations only") and surfaces the same signals as advisory context instead.

### Pull the latest shared demos and code

```bash
npm run pipe -- pull
```

This runs `git pull --ff-only` in **this repo** (pipeline code) and syncs **`~/.plaid-demo-apps`** (shared demos). **Requires [GitHub authentication](#github-authentication--pull-updated-code--shared-demo-repo)** — `gh` login plus SSH or HTTPS credentials for `git`, and collaborator access on both repositories. Any demo another engineer has published is then browsable in the dashboard.

### Publish your own demo

```bash
npm run pipe -- publish <run-id>
```

This packages the demo (strips your `.env`, research artifacts, and logs; runs a secret-sweep), copies it into `~/.plaid-demo-apps/demos/<your-login>/<run-id>/`, and opens a PR against `main` via `gh pr create`. CODEOWNERS on the artifact repo auto-approves your own folder; maintainers review any cross-user change. Full trust-model details in [`docs/distribution-architecture.md`](docs/distribution-architecture.md).

---

## Dashboard tabs at a glance

| Tab | What it's for |
|-----|---------------|
| **Overview** | Current run summary, product-knowledge status, previous builds. |
| **Pipeline** | Live stage badges, log viewer, CLI copy-to-clipboard for non-read operations. |
| **Storyboard** | Per-scene narration editor, scene timing, add/insert slides, timeline editor. |
| **Demo Apps** | Launch + preview every built or published demo. Search, filter (`All` / `Mine`), publish, download. |
| **Config** | ~30 pipeline flags with hover tooltips. Edit-and-save; secrets still live in `.env`. |
| **Product Knowledge** | Per-product markdown (`inputs/products/*.md`). Edit-and-save only — research refreshes value props automatically when `last_vp_research` is older than 30 days. |

---

## GitHub Enterprise — current deployment

The Plaid Sales Engineering deployment lives on **`github.plaid.com`** under the `dmajetic` namespace (personal account, since org-level repo creation isn't currently in scope):

| Repo | Purpose | URL |
|------|---------|-----|
| `dmajetic/plaid-demo-recorder` | This codebase. SEs read-pull; merges via PR + Code Owners review. | <https://github.plaid.com/dmajetic/plaid-demo-recorder> |
| `dmajetic/plaid-demo-apps` | Published demo bundles. SEs publish via PRs that auto-merge into their own `demos/<their-login>/**` namespace. | <https://github.plaid.com/dmajetic/plaid-demo-apps> |

Branch protection on both `main` branches:

- Require a pull request before merging
- Require approvals (1)
- **Require review from Code Owners** (gates each path by the matching CODEOWNERS line)
- Require conversation resolution
- Require linear history
- Include administrators *(also binds the repo owner — no force-push escape hatch)*
- *No "Restrict who can push" — that option only appears on org-owned repos.*

CODEOWNERS on `plaid-demo-apps` references individual GHE logins so every SE auto-approves PRs in their own folder; cross-user changes need a maintainer review. SE teammates are added one at a time via **Settings → Collaborators** (Read on the code repo, Write on the artifact repo) — there's no team-grant since teams don't exist outside an org namespace.

### Onboard a new sales engineer

Send them this block. The installer is idempotent and safe to re-run.

```bash
# One-time per laptop (~3 min)
# If you've never used `gh`, run the next command and follow the prompts:
#   GitHub Enterprise Server → hostname github.plaid.com → SSH or HTTPS → browser or PAT.
# See README § "First time with GitHub or the GitHub CLI?" for details.
gh auth login --hostname github.plaid.com
cat >> ~/.zshrc <<'EOF'
export PLAID_GHE_HOSTNAME=github.plaid.com
export PLAID_DEMO_APPS_REPO=https://github.plaid.com/dmajetic/plaid-demo-apps
# or SSH: git@github.plaid.com:dmajetic/plaid-demo-apps.git
EOF
source ~/.zshrc

git clone git@github.plaid.com:dmajetic/plaid-demo-recorder.git
cd plaid-demo-recorder
bash scripts/setup/install.sh

# verify
npm run pipe -- whoami    # should print Login: <ghe-login>, Host: github.plaid.com
npm run pipe -- pull      # syncs both repos
```

The installer reads `PLAID_GHE_HOSTNAME` / `PLAID_DEMO_APPS_REPO` from the current shell **or** from `~/.zshrc` (and `~/.bashrc`, `~/.bash_profile`) — so even if they forget to `source` after editing rc files, it still picks them up.

After onboarding, daily commands:

```bash
npm run pipe -- pull                     # latest code + shared demos
npm run quickstart                       # guided wizard for a new app-only demo
                                         #   (asks brand/persona/products → writes prompt.txt
                                         #    + research task; agent runs AskBill + Glean,
                                         #    then `npm run demo` kicks off and stops at
                                         #    build-qa for fast agent-driven iteration)
npm run demo                             # iterate: app-only build + QA, stops at build-qa
                                         #   (agent-mode default — no recording cost)
npm run demo:full                        # ship: full pipeline through MP4 render + ppt
npm run pipe -- new --app-only           # alternative: build from a hand-written prompt.txt
npm run pipe -- publish <run-id>         # share a demo (auto-merges into your namespace)
```

When the pipeline pauses on a continue-gate (the default under `PIPE_AGENT_MODE=1`), open the task .md it printed in **Cursor or Claude Code in Agent mode**, let the agent edit, then run `npm run pipe -- continue <run-id>` to release. See [What you'll see when the pipeline runs](#what-youll-see-when-the-pipeline-runs) for the gate flow.

### Maintainer playbook — adding a new SE collaborator

When a new SE joins:

1. **Add to code repo as Read collaborator**
   <https://github.plaid.com/dmajetic/plaid-demo-recorder/settings/access> → Add people → role **Read**.
2. **Add to artifact repo as Write collaborator**
   <https://github.plaid.com/dmajetic/plaid-demo-apps/settings/access> → Add people → role **Write**.
3. **Append a CODEOWNERS line** in `plaid-demo-apps` so they auto-approve their own folder:
   ```
   /demos/<their-login>/**   @<their-login>
   ```
   Open a PR from a feature branch (CODEOWNERS edits on `main` need a Code Owner review, which is you).
4. **Send them the onboarding block** above. The teammate's `pipe publish` will then succeed end-to-end without needing your review (CODEOWNERS auto-approves their namespace).

If you transfer either repo to an org namespace later, the only client-side change is updating each teammate's `PLAID_DEMO_APPS_REPO` env var (and the `git remote set-url` they ran during onboarding). The CODEOWNERS lines stay valid as-is once you re-target them at a team (e.g. `@<org>/demo-recorder-maintainers`).

---

## Setting up a fresh GHE instance from scratch (reference)

If you ever bring this to a different GHE host or move to an org namespace, the steps are:

### 1. Create the repos

| Repo | Visibility | Settings |
|------|-----------|----------|
| `<owner>/plaid-demo-recorder` | Internal or Private | Push initial commit from this working copy. |
| `<owner>/plaid-demo-apps` | Internal or Private | Initialize with the `README.md` + `CODEOWNERS` template below. |

### 2. CODEOWNERS templates

**`plaid-demo-recorder/.github/CODEOWNERS`** — *org-owned variant:*
```
*    @<org>/demo-recorder-maintainers
```

**`plaid-demo-recorder/.github/CODEOWNERS`** — *personal-repo variant (current deployment):*
```
*    @<owner>
```

**`plaid-demo-apps/CODEOWNERS`** — both variants share this shape; team vs. user is the only difference:
```
# Fallback — maintainer reviews any cross-cutting change.
*                       @<owner-or-team>
# Per-user namespaces. Each SE auto-approves their own folder.
/demos/<login>/**       @<login>
```

### 3. Branch protection (both repos)

`Settings → Branches → Add branch protection rule` on `main`:

```
☑ Require a pull request before merging
   ☑ Require approvals → 1
   ☑ Require review from Code Owners
   ☑ Dismiss stale pull request approvals when new commits are pushed
☑ Require conversation resolution before merging
☑ Require linear history
☑ Include administrators
☐ Allow force pushes
☐ Allow deletions
☑ Restrict who can push to matching branches    ← only available on org-owned repos
```

The `Restrict who can push` checkbox is the **only** branch-protection difference between org-owned and personal-namespace repos. Everything else works identically.

### 4. Tell engineers to onboard

```bash
# one-time
gh auth login --hostname <ghe-host>
export PLAID_GHE_HOSTNAME=<ghe-host>
export PLAID_DEMO_APPS_REPO=git@<ghe-host>:<owner>/plaid-demo-apps.git
git clone git@<ghe-host>:<owner>/plaid-demo-recorder.git
cd plaid-demo-recorder
bash scripts/setup/install.sh

# verify
npm run pipe -- whoami
```

---

## Troubleshooting the installer

| Symptom | Fix |
|---------|-----|
| `node is too old` | `nvm install 20 && nvm use 20` (install `nvm` from <https://github.com/nvm-sh/nvm> first). |
| `gh: command not found` after install | Install [Homebrew](https://brew.sh) and re-run `bash scripts/setup/install.sh`, or install manually: `brew install gh` / <https://cli.github.com>. |
| `ffmpeg: command not found` after install | Same: use Homebrew + re-run the installer, or `brew install ffmpeg` / Debian `sudo apt-get install ffmpeg` — required for full pipeline video. |
| `npm install` fails on `playwright` | Re-run `npx playwright install chromium` separately. |
| `pipe whoami` returns no login | `gh auth status --hostname <ghe-host>`; if not signed in, `gh auth login --hostname <ghe-host>`, then re-run `pipe whoami`. See [First time with GitHub or the GitHub CLI?](#first-time-with-github-or-the-github-cli). |
| Never authenticated GitHub / first time using `gh` | Install `gh`, then `gh auth login --hostname <ghe-host>` — choose Enterprise Server, enter hostname, SSH vs HTTPS, then browser or PAT. Verify with `gh auth status`. |
| Artifact repo clone fails | Confirm `PLAID_DEMO_APPS_REPO` is set and you have read access. Try `git clone <url>` manually to get a real error message. |
| `pipe pull` — `fatal: not a git repository` on **this** repo | You’re in a **ZIP** copy (no `.git`). That’s expected — only a **git clone** can `git pull` code updates. Use a fresh `git clone` of `plaid-demo-recorder` if you need upstream changes; the pipeline still runs from a ZIP. **Update** to a `pipe` that detects missing `.git` so the message is explicit. |
| `Permission denied (publickey)` cloning **plaid-demo-apps** | **SSH:** Add your machine’s public key to GHE (**Settings → SSH keys**), then `ssh -T git@github.plaid.com`. **Or** use HTTPS + PAT: `export PLAID_DEMO_APPS_REPO=https://github.plaid.com/dmajetic/plaid-demo-apps.git` (use a **personal access token** as the password when git prompts). You must be a **Read** collaborator on that repo. |
| `.env` missing after install | Installer skips existing `.env` files. Delete yours or manually copy from `.env.example`. |

---

## Quick links

- **Get up and running quickly** (terminal → Claude Code → `npm run demo`) → [above](#get-up-and-running-quickly)
- **Pipeline architecture + stage list** → [`CLAUDE.md`](CLAUDE.md)
- **Distribution / publish flow** → [`docs/distribution-architecture.md`](docs/distribution-architecture.md)
- **CLI reference for Claude / agent use** → [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md)
- **Dashboard UI reference** → open <http://localhost:4040> after `npm run dashboard`
- **Prompt authoring examples** → [`docs/prompt-examples.md`](docs/prompt-examples.md)
