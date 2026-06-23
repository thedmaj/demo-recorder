# Plaid Demo Recorder — Sales Engineer Onboarding

Build hyper-realistic Plaid demo **apps** (real host UI + a live Plaid Link integration) from a single prompt — by **chatting with a Claude Code agent**. You describe the customer story; the agent writes the prompt, runs the pipeline, watches the build, and recovers it. Almost everything below is run *for* you by the agent — you mostly talk to it in plain English.

> **Scope:** this guide gets you from a blank Mac → installed → first demo, in **agent mode**, plus how to contribute enhancements. It complements [`README.md`](README.md) (the line-by-line install reference) — when this guide says "see README §N," open that. Default builds are **app-only** (fast, no recording); full-pipeline render is advanced and being stabilized.

---

## 0. Quick start — how this guide runs in Claude Code

On the share page, click **Copy ONBOARDING.md** (top right) — that copies this **entire guide**. Then open Claude Code **inside the repo folder** (`cd plaid-demo-recorder && claude`) and **paste the whole guide as your first message**. The agent reads all of it; the **operating instructions below** tell it to drive setup → secrets → validation → your first demo, pausing only where it needs you.

> First time? Two prerequisites the share page can't do for you: (1) if you don't have Claude Code, run the install commands at the bottom of the share page; (2) if you haven't cloned the repo yet, do **§2–4** first (Claude Code must be running *inside* the cloned repo before you paste). The operating instructions below also exist as [`ONBOARDING-bootstrap.txt`](ONBOARDING-bootstrap.txt) if you'd rather paste just them.

**Operating instructions (the agent follows these first):**

```text
You are my onboarding guide for the Plaid Demo Recorder. Use ONBOARDING.md in this
repo as the source of truth and walk me through setup, then my first demo. Go step
by step, confirm before any install, and STOP at any step that needs me (interactive
auth or secrets).

1. Confirm we're inside the cloned repo (ls shows package.json + ONBOARDING.md).
2. Run `bash scripts/setup/install.sh` and summarize what it did (it writes a TEMPLATE .env).
3. SECRETS — stop and tell me: "Request the completed `.env` from David Majetic
   (dmajetic@plaid.com)." Wait until I confirm I have it, then:
   - Ensure David's `.env` is at the REPO ROOT as `./.env`, replacing the template.
     Verify without printing the key:
       test -f ./.env && grep -q '^ANTHROPIC_API_KEY=.\+' ./.env && echo ".env OK at repo root" || echo ".env missing or key empty"
   (No GCP service-account JSON needed — embeddings use the GOOGLE_API_KEY in `.env`.)
4. VALIDATE — run `npm run pipe -- validate-env` then `npm run pipe -- whoami`. Do not
   continue until validate-env prints "✓ Required checks passed".
5. Then ask me for a demo scenario and build my first demo per ONBOARDING §10
   (default app-only `npm run demo`; full video only if I ask).
Note: `gh auth login --hostname github.plaid.com` is interactive — I run it, not you.
Never commit `.env`.
```

---

## 1. How you'll work (read this first)

You operate in **agent mode**: you run **Claude Code** inside the repo folder and chat with it. The agent runs the CLI (`npm run pipe …`), posts status while builds run, and fixes failures. You rarely type CLI commands yourself — you say *"build a demo for …"*, *"what's the status?"*, *"fix the slides."* §9 lists the phrases.

---

## 2. Prerequisites (macOS)

```bash
# Homebrew (if `brew --version` fails): https://brew.sh
node -v                      # need 20+ ; if missing: `nvm install 20 && nvm use 20`
brew install git gh ffmpeg   # git, GitHub CLI, ffmpeg
```

## 3. Install & update Claude Code

```bash
# Install (either works):
curl -fsSL https://claude.ai/install.sh | bash      # native installer
#   …or…
npm install -g @anthropic-ai/claude-code

claude --version             # verify
claude update                # keep it current (run this whenever you start work)
```
You'll log in to Claude on first launch. Tip: `/fast` inside Claude Code enables Fast mode (Opus, faster output).

## 4. Get access to the code (GitHub Enterprise — no prior GHE experience needed)

The repo lives on Plaid's **GitHub Enterprise** at `github.plaid.com` (separate from public github.com). Authenticate once with the GitHub CLI:

```bash
gh auth login --hostname github.plaid.com
#  → choose: GitHub Enterprise Server → hostname github.plaid.com → HTTPS → "Login with a web browser"
#  → if the browser flow fails: choose "Paste an authentication token" and create a PAT with `repo` scope
gh auth status --hostname github.plaid.com          # should show your login
```

Then clone the repo (HTTPS — `gh` supplies credentials automatically):

```bash
git clone https://github.plaid.com/dmajetic/plaid-demo-recorder.git
cd plaid-demo-recorder
```

> You'll be added as a **collaborator** (ask the owner). You don't fork — you push branches to this repo and open PRs (see §13).

## 5. One-command install + secrets

```bash
bash scripts/setup/install.sh
```
This idempotent installer (safe to re-run anytime to update) does it all: verifies prerequisites, `npm install`, creates `.env` from the template, prefetches MCP packages, sets up the vidmagik render engine, confirms `gh` auth, caches your identity, clones the shared demo catalog (`~/.plaid-demo-apps`), and installs the Playwright browser.

**Secrets come from David Majetic — not self-provisioned.** Message **David Majetic (dmajetic@plaid.com)** and request **the completed `.env`** (Anthropic, Plaid sandbox, ElevenLabs, Glean/AskBill, GOOGLE_API_KEY, etc.). There is **no GCP service-account JSON** — Google embeddings use the `GOOGLE_API_KEY` in `.env`.

**Place it correctly (the relative path matters):**
- **`.env` → the repo root**, i.e. `plaid-demo-recorder/.env` (replace the template `install.sh` wrote). The pipeline only reads `.env` from the repo root — a `.env` left in `~/Downloads` or a subfolder will not be found. **Never commit `.env`** (it's gitignored).
  ```bash
  mv ~/Downloads/plaid-demo-recorder.env ./.env      # run from the repo root
  test -f ./.env && grep -q '^ANTHROPIC_API_KEY=.\+' ./.env \
    && echo ".env OK at repo root" || echo ".env missing or ANTHROPIC_API_KEY empty"
  ```

**Validate before going further — do not proceed until this passes:**
```bash
npm run pipe -- validate-env    # expect: [env-check] ✓ Required checks passed
npm run pipe -- whoami          # your GHE identity
```
If `validate-env` flags a key, it's missing/blank in the `.env` — re-check you placed **David's** file at the repo root (not the template), or ask David for the specific value. Only `ANTHROPIC_API_KEY` is strictly required for a basic build; everything else degrades gracefully. Full handoff reference: **README §2**.

## 6. MCP servers

**Research MCPs (optional — wired by the install + your `.env`; builds still complete without them, just with less customer color):**
- **AskBill** — Plaid product/API documentation Q&A. Wired via `.mcp.json` / `ASKBILL_MCP_COMMAND` (the installer prefetches the bridge). Without it: `[AskBill unavailable]`.
- **Glean (pipeline research)** — `@gleanwork/local-mcp-server`, internal knowledge (Gong calls, collateral, customer stories) used by the pipeline's `research` stage. Enabled by `GLEAN_INSTANCE` + `GLEAN_API_TOKEN` in `.env`. Without it: `[Glean unavailable]`.
- **Official Glean Claude connector (recommended for ad-hoc work)** — also connect the **official Glean MCP connector in Claude Code** (`/mcp` → add Glean) for *interactive* research and prompt building/enhancing — e.g. "pull the <Account> opportunity context from Glean and draft the prompt." It's richer than the local server (search + read-document + people) and uses managed OAuth (no token in `.env`). The pipeline's headless `research` stage keeps using the local Glean above; you use the official connector when chatting with the agent.

**Render engine — vidmagik-mcp (required for video render; app-only builds skip it):**
The final video render uses the **MoviePy MCP server `vidmagik-mcp`**. Default app-only builds (`npm run demo`, stop at build-qa) **don't render**, so you don't need it to start. For full-pipeline video you must install it:

```bash
brew install uv                                   # Python runner vidmagik uses
mkdir -p ~/.mcp-servers && git clone https://github.com/vizionik25/vidmagik-mcp.git ~/.mcp-servers/mcp-moviepy
git -C ~/.mcp-servers/mcp-moviepy checkout pipeline-patches   # the branch the pipeline depends on
```
- **Repo:** `https://github.com/vizionik25/vidmagik-mcp` · **branch `pipeline-patches`** (raised clip cap + the custom effects `render-moviepy.js` calls — stock `main` is not sufficient). This is the canonical server; the similarly-named `vizionik25/moviepy-mcp` is a *different* project — do not use it.
- **Location:** `~/.mcp-servers/mcp-moviepy` (the path `render-moviepy.js` and `.mcp.json` expect).
- Without it, render **falls back to Remotion** (works, lower fidelity) — so a missing/incorrect vidmagik install silently degrades quality rather than failing loudly.

**figma** MCP is optional (design flows only).

---

## 7. How a build works in agent mode (heartbeat + monitoring)

Start Claude Code from the repo folder — that's what makes it agent mode:

```bash
cd plaid-demo-recorder
claude
```

When you ask for a build, the agent runs the pipeline and **monitors it for you**:
- The pipeline emits a **heartbeat** (`::PIPE:: event=heartbeat`) every **5 minutes** while a stage runs, and writes `pipeline-heartbeat.json`. The agent posts a one-line status on each tick (`stage=build-qa, elapsed=…s, awaiting=false`) — so a long build never looks "stuck."
- The agent polls **`npm run pipe -- status --json`** to decide the next action (and tells you what it ran).
- Builds run **unattended** (`--non-interactive` / `SCRATCH_AUTO_APPROVE`); if the pipeline needs you, it pauses on a "continue-gate" and the agent surfaces the task.
- Default `npm run demo` is **app-only** and stops at `build-qa` after an automatic touch-up loop — fast iteration, no recording.
- Watch live in the **dashboard** (run once in a second terminal): `npm run dashboard` → http://localhost:4040.

You don't memorize any of this — the agent does it. You just read its updates.

---

## 8. The prompt template → storyboard

A demo is generated from a **prompt** (`inputs/prompt.txt`). The agent fills it from a template; you supply the *story*, not the tech. Template skeleton (full version: [`inputs/prompt-template.txt`](inputs/prompt-template.txt); simple app-only version: `inputs/prompt-template-app-only.txt`):

```
«DEMO TITLE» — «ONE-LINE VALUE PROPOSITION»
Host: «HOST_APP_NAME» — «industry»     Canonical URL / Brand URL: «https://…»
User journey (one sentence): «…»
Story arc: «Problem → how Plaid enters → frictionless steps → quantified reveal → outcome»
Products featured: «Plaid Link, Plaid Auth, Plaid Signal, …»   (approved names only)
Solutions supported: «Account Opening, Funding, …»   ← queries Solutions Master
Primary product family: «funding | cra_base_report | income_insights | …»
Primary messaging file: «inputs/products/plaid-….md»   ← owns the stats
Research depth: «full | gapfill | messaging | skip»   (omit = gapfill)
STORYBOARD BEATS (order = script order):
  | # | Beat (host/link/insight/slide) | What the viewer sees | Narration focus | Reveal/CTA |
Persona & sample data: name/role, company, on-screen amounts/scores (no placeholders)
Host chrome: nav + entry screen + the CTA that opens Link.   Viewport: 1440×900.
```

**How it becomes a storyboard:** `research` (Solutions Master + AskBill + Glean) → `script` writes **`demo-script.json`**, whose ordered **`steps[]`** *are* the storyboard (each step = a screen with narration, visual state, and optional API panel). `build` turns those steps into the host app; the **dashboard storyboard view** shows each beat with its screenshot + narration + API JSON.

### Example A — pure natural language
> *"Build an app-only demo for **Cox Automotive** showing **Plaid Bank Income** for instant auto-finance income verification. Persona: Daniel Carter, a buyer financing a $24,600 used car at the dealer finance desk. Story: replace the paystub chase — he links his checking account via Plaid Link, Bank Income returns verified income, and the desk clears him for financing. Research depth gapfill."*

The agent writes `inputs/prompt.txt` from the template and runs `npm run demo`.

### Example B — from a Salesforce opportunity (via Glean)
> *"Build a demo for the **<Account Name>** opportunity. Pull their context from Glean first."*

The agent calls **Glean** (`gleanChat`) for that account's Gong-call themes, use case, products under evaluation, and persona color, then fills the template — `Solutions supported`, persona/company, and story arc reflect *their* real pain points — and runs the build. (Glean is the bridge to Salesforce context; set `GLEAN_INSTANCE`/`GLEAN_API_TOKEN` in `.env`.)

---

## 9. Top 10 commands — just say the phrase (agent mode)

You speak the left column; the agent runs the right. (You can type the command yourself, but you don't have to.)

| Say this | Agent runs | What it does |
|---|---|---|
| "Build a demo for <story>" | `npm run pipe -- new --non-interactive` | App-only build → build-qa (fast) |
| "Build it with slides" | `npm run pipe -- new --with-slides --non-interactive` | Adds the slide deck |
| "What's the status?" | `npm run pipe -- status --json` | Stage, QA score, next step |
| "Keep an eye on it" | `npm run pipe -- monitor` | Re-emits the 5-min heartbeat |
| "Show me the logs" | `npm run pipe -- logs --follow` | Tail the build log |
| "Fix the app" (app score low) | `npm run pipe -- app-touchup --non-interactive` | Surgical app-tier repair |
| "Fix the slides" | `npm run pipe -- slide-fix --non-interactive` | Slide-tier repair |
| "Re-record / redo from <stage>" | `npm run pipe -- resume --from=<stage> --non-interactive` | Resume from a stage |
| "Open the demo / dashboard" | `npm run dashboard` + `npm run pipe -- open` | Review in the browser (:4040) |
| "Stop it" / "Continue" | `npm run pipe -- stop` / `… continue` | Halt, or release a continue-gate |

(Also: "research deeper" → `--research=broad`; "list recent runs" → `pipe list`; "publish this demo to the catalog" → `pipe publish`.)

---

## 10. Tutorial: build a demo end-to-end (through record + video)

The default `npm run demo` stops at **build-qa** (fast app-only iteration, **no video**). To get a finished video you run the **full** pipeline. In agent mode you just say *"build the full video for …"*; here's what happens and the commands behind it.

**A. Kick it off (agent mode)**
```bash
cd plaid-demo-recorder && claude
```
Then tell the agent your scenario (or run `npm run quickstart` first). To go all the way to a rendered video:

| You say | Agent runs | Result |
|---|---|---|
| "Build the full video for <story>" | `npm run demo:full` (app-only, through render) | `demo-scratch.mp4` |
| "Full video **with slides**" | `npm run demo:with-slides` (slides + render) | `demo-scratch.mp4` with deck |
| "Just iterate the app first" | `npm run demo` (stops at build-qa) | no video yet |

**B. What the pipeline does (watch live at `npm run dashboard` → :4040)**
`research → script → build → build-qa` (auto touch-up loop to score ≥85) `→ post-slides/post-panels → record → qa → post-process → voiceover → render → demo-scratch.mp4`.
- **record** opens a real Chromium window and drives **live Plaid Link** (~1–2 min — let it run; it's not stuck).
- The agent posts heartbeat status the whole time; if a continue-gate fires it opens the task `.md`, makes the edit, and runs `pipe continue`.

**C. When it finishes** — "open the demo" → the agent plays `demo-scratch.mp4`. To redo just the recording later: *"re-record"* → `npm run pipe -- resume --from=record`.

> If you edited the storyboard (narration, added a slide) **after** the first build, re-record from `--from=set-recording-dwells` (not `--from=record`) — the agent handles this; it re-syncs the recording script + dwells to your new narration.

---

## 11. Manual touch-ups (app tier & slide tier)

After `build-qa`, the pipeline auto-runs **up to 2 app-touchup + 2 slide-fix** iterations and stops once the score hits **≥85**. You can also drive them yourself — in agent mode just say *"fix the app"* or *"fix the slides."* They are **surgical** (they never regenerate the whole app/deck):

- **App tier — `npm run pipe -- app-touchup <run-id>`**: repairs the host app (DOM contract, API panel visibility, Plaid Link CTA, link-token products). Applies deterministic patches → `post-panels` → re-scores **app steps only**. Anything it can't auto-fix is written to **`qa-app-touchup-task.md`** — open it in agent mode, make the listed edits to `demo-script.json` / the app HTML, then `npm run pipe -- continue <run-id>`.
- **Slide tier — `npm run pipe -- slide-fix <run-id>`**: repairs **slides only** (app+slides builds). Patches → regenerates the flagged slides → re-scores slide steps. Residual items go to **`qa-slide-fix-task.md`**. It **refuses to run while the app tier is still failing** — fix the app first.
- **Storyboard edits** (rewrite narration, insert/remove a slide, reorder) live in the dashboard **Storyboard** tab. After changing narration, the demo must be re-recorded (`--from=set-recording-dwells`) so timing matches — the agent does this for you.

Rule of thumb: 2 app + 2 slide iterations, exit at ≥85; a passing build below 85 is still shippable — don't grind.

---

## 12. Basic video editing — speed, freeze, crop

The recorded screen video is automatically **retimed to fit the narration** (the *sync-map*). The golden rule: **narration is ground truth; the video is warped to fit it** — so length-changing edits (speed/freeze) go through the sync-map, while overlay edits (crop/zoom) are applied at render.

- **Speed** — compress a too-long screen (e.g. play a slow multi-field form at 1.5×) so it doesn't drag.
- **Freeze** — hold a frame: linger on a score/decision reveal, or pad a too-fast screen. *(The pipeline already auto-freezes any Plaid Link screen shorter than 2s.)*
- **Where:** speed/freeze are segments in **`sync-map.json`**, edited visually in the dashboard **Timeline Editor** (or the agent adds them — each segment is `{compStart, compEnd, videoStart, mode: speed|freeze|normal, speed?}`). **After any speed/freeze change, run Resync Audio** (`npm run pipe -- stage resync-audio`) so the voiceover re-aligns — the dashboard flags a sync-map that changed without a resync.
- **Crop / zoom** — *not* a one-click control; it's a render effect (MoviePy `vfx_crop` / zoom-punch). Ask the agent: *"zoom in on the identity-match score from 0:42–0:48"* and it applies the crop on the next render. Crop/zoom don't change scene length, so they're safe to add without touching the sync-map.

In agent mode you describe the edit in plain English (*"slow the form-fill scene, freeze on the approval, and zoom the score"*) — the agent translates speed/freeze into sync-map segments (+ resync) and crop/zoom into render effects, then re-renders.

---

## 13. Submitting enhancements (PRs)

Two kinds of changes follow two review paths. Both: branch off `main`, push to this repo (you're a collaborator), open a PR — `main` requires a PR + code-owner approval.

- **Application code** (`scripts/`, `bin/`, `remotion/`, `.claude/`, `tests/`, `docs/`): ask the agent to **review your branch before you open the PR** ("review my changes for a PR") — it diffs against `main` and flags issues; address them, then `gh pr create`.
- **GTM stats / product knowledge** (`inputs/products/*.md`, value props, claims): these need **human sign-off**. Keep AI-suggested edits marked `[DRAFT]`; a human owner reviews and bumps the `approved` / `last_human_review` frontmatter before it's used. **Do not** commit Gong/$/%/threshold stats without sign-off.

> The full two-lane workflow (CODEOWNERS routing, a frontmatter governance check, PR template) is being finalized — `CONTRIBUTING.md` will be the source of truth. For now, ask the owner before submitting KB/GTM changes.

---

## 14. Troubleshooting & help

- **Anything fails?** `npm run pipe -- validate-env` first — most issues are a missing/blank key.
- **Build looks stuck:** it isn't if heartbeats are ticking; ask the agent "what's the status?" (vision QA can take ~20 min silently).
- **`[Glean unavailable]` / `[AskBill unavailable]`:** research creds aren't set — builds still work; ask the owner for the values.
- **Re-running `bash scripts/setup/install.sh`** is the safe way to refresh deps after a `git pull`.
- **Architecture & deep rules:** [`CLAUDE.md`](CLAUDE.md). Agent/heartbeat contract: [`AGENTS.md`](AGENTS.md). CLI reference: [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md). Sharing demos: [`docs/distribution-architecture.md`](docs/distribution-architecture.md).
- **Stuck?** Ping the repo owner.
