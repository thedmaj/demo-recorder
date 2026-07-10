# Plaid Demo Recorder — Sales Engineer Onboarding

Build hyper-realistic Plaid demo **apps** (real host UI + a live Plaid Link integration) from a single prompt — by **chatting with a Claude Code agent**. You describe the customer story; the agent writes the prompt, runs the pipeline, watches the build, and recovers it. Almost everything below is run *for* you by the agent — you mostly talk to it in plain English.

> **⚠️ Must be run in the Claude Code terminal.** This pipeline is operated by a [Claude Code](https://claude.com/claude-code) agent running **inside the repo folder** (`cd plaid-demo-recorder && claude`) — not from a plain shell. Every step below is executed in that Claude Code session; you talk to the agent in plain English and it runs the commands. (Need to run one yourself? Type `! <command>` at the Claude Code prompt.)

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

1. Confirm we're inside the repo folder (ls shows package.json + ONBOARDING.md). If
   not, tell me to get the code first (§4): Option A `git clone` from GitHub Enterprise
   (preferred), or Option B download + unzip the ZIP if I lack GHE access.
2. Run `bash scripts/setup/install.sh` and summarize what it did (writes a TEMPLATE .env;
   GENERATES per-machine `.mcp.json` from `.mcp.json.template` + verifies AskBill). Tell me
   to restart Claude Code once after the first install so the MCP servers load.
   (Option B ZIP installs have no `.git` — the installer detects that and auto-skips
   the GitHub steps: gh CLI, GHE auth, identity cache, artifact-repo clone. Expected,
   not an error.)
3. SECRETS — stop and tell me: "Request the completed `.env` from David Majetic
   (dmajetic@plaid.com)." Wait until I confirm I have it, then:
   - Ensure David's `.env` is at the REPO ROOT as `./.env`, replacing the template.
     Verify without printing the key:
       test -f ./.env && grep -q '^ANTHROPIC_API_KEY=.\+' ./.env && echo ".env OK at repo root" || echo ".env missing or key empty"
   (No GCP service-account JSON needed — embeddings use the GOOGLE_API_KEY in `.env`.)
4. VALIDATE — run `npm run pipe -- validate-env` then `npm run pipe -- whoami`. Do not
   continue until validate-env prints "✓ Required checks passed". (Option B / no-GHE
   installs: skip `whoami` — it needs GitHub auth; validate-env is the gate.)
5. Setup is complete — FIRST orient me. Show me a few **natural-language sample
   prompts** that illustrate how to opt in/out of the two build toggles, and call
   out the defaults: **a build includes the app + the Plaid API/JSON side panels,
   and no slides — slides are opt-in, the JSON panels are opt-out** (see §9 →
   "Slides & JSON panels — opt in or out"). Keep it to ~4–5 example phrases, e.g.
   *"Build the Acme Bank Income demo"* (app + JSON panels, no slides · default),
   *"…with slides"*, *"…without the API panels"*, *"app only — no slides, no API
   panels"*, *"build the full video with slides"*. THEN ask me for a demo scenario.
   REQUIREMENTS INTAKE — before writing
   `inputs/prompt.txt`, confirm I've given enough to fill the prompt template
   (§8). If the request is vague, do NOT guess — ask up to ~4 targeted questions
   for the missing pieces first, especially the EXACT Plaid product(s) by approved
   name + family ("CRA Base Report" / cra_base_report, not "a lending demo"); if
   unsure which product I mean, list candidates and ask me to choose. REVIEW GATE —
   before writing `inputs/prompt.txt` or building, show me an easy-to-read, high-level
   summary of the proposed demo (title, host, products, persona, the story arc, the
   ordered beats, build mode/research depth — plain language, no raw prompt/JSON) and
   STOP: "Want any changes, or should I build it?" If I ask for edits, update and
   re-show the summary; loop until I approve. Only after I approve, build per §10
   (default app-only `npm run demo`; full video only if I ask).
Note: `gh auth login --hostname github.plaid.com` is interactive — I run it, not you.
Never commit `.env`.
```

---

## 1. How you'll work (read this first)

You operate in **agent mode**: you run **Claude Code** inside the repo folder and chat with it. The agent runs the CLI (`npm run pipe …`), posts status while builds run, and fixes failures. You rarely type CLI commands yourself — you say *"build a demo for …"*, *"what's the status?"*, *"fix the slides."* §9 lists the phrases.

---

## 2. Prerequisites (macOS)

> **Fresh Mac with no dev tools?** You can skip this section — `install.sh` (§5)
> detects what's missing and offers to bootstrap Homebrew (whose installer also
> sets up the Xcode Command Line Tools) and install everything below through it.
> To do it by hand instead, the prescriptive list is:

```bash
# Homebrew (if `brew --version` fails): https://brew.sh
brew install node git ffmpeg python@3.12   # node 20+, git, ffmpeg, python 3.10+ (AskBill needs ≥3.10 — stock macOS 3.9 is too old)
brew install gh                            # GitHub CLI — Option A (GHE) only; skip for ZIP installs
node -v                      # verify 20+ (nvm users: `nvm install 20 && nvm use 20`)
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

## 4. Get the code — two options

Use **Option A (GitHub Enterprise)** if you have access — it's the preferred path (real `git` clone → auto-updates before each build, and you can contribute PRs). **Not everyone has GHE access; if you don't, use Option B (ZIP download).**

### Option A — GitHub Enterprise (preferred, no prior GHE experience needed)

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

### Option B — ZIP download (if you don't have GitHub Enterprise access)

Download the source as a ZIP, unzip it, and `cd` into the folder:

1. Open **https://drive.google.com/file/d/1_WPeeNoGNIxK3Q4t4q8h2xONR3ZwJpYd/view?usp=sharing** in your browser and click **Download** (for a large file, Google Drive may say it "can't scan for viruses" — choose **Download anyway**).
2. Unzip it and enter the folder (adjust the filename to what landed in `~/Downloads`):
   ```bash
   cd ~/Downloads
   unzip plaid-demo-recorder*.zip
   cd plaid-demo-recorder            # the unzipped folder (name may vary)
   ```
3. Continue at §5 (install) — the ZIP contains everything `install.sh` needs.

> **ZIP caveats (it's a snapshot, not a git clone):**
> - **No auto-update.** Builds normally fast-forward the clone to the latest templates/fixes before running; a ZIP has no `git` history, so that's skipped. To get a newer version, **re-download the ZIP** (or switch to Option A).
> - **You can't contribute PRs from a ZIP** — submitting enhancements (§13) requires the GitHub Enterprise clone (Option A). Ask the owner for access when you're ready to contribute.
> - **`install.sh` auto-skips the GitHub steps.** With no `.git` directory it detects a manual install and skips the gh CLI requirement, GHE auth, identity cache (`pipe whoami`), and the shared demo-catalog clone — no GHE account needed to install and build. If you later get GHE access, re-run with `SKIP_GITHUB=false bash scripts/setup/install.sh`.
> - **No dev tools required.** On a fresh Mac the installer offers to bootstrap Homebrew (the official installer also sets up the Xcode Command Line Tools) and installs node, git, python3, and ffmpeg through it. Nothing on GHE is needed for tools — git only pulls the public `vidmagik-mcp` render engine from github.com.
> - **All MCP servers work from the ZIP.** The AskBill server is vendored in the repo (`scripts/setup/mcp-servers/askbill-plaid/`) and auto-provisioned to `~/plaid-mcp-servers/`; Playwright MCP (`@playwright/mcp`) is prefetched from npm; moviepy (vidmagik-mcp) clones from public github.com; figma MCP is remote HTTP. None of them need GHE.
> - Everything else (setup, secrets, building demos) works identically.

## 5. One-command install + secrets

```bash
bash scripts/setup/install.sh
```
This idempotent installer (safe to re-run anytime to update) does it all: verifies prerequisites (bootstrapping Homebrew + node/git/python3/ffmpeg on a fresh Mac with no dev tools), `npm install`, creates `.env` from the template, prefetches MCP packages, sets up the vidmagik render engine, generates the per-machine `.mcp.json` and provisions the AskBill MCP server from the repo's vendored copy, prefetches Playwright MCP, confirms `gh` auth, caches your identity, clones the shared demo catalog (`~/.plaid-demo-apps`), and installs the Playwright browser. On a manual/ZIP install (no `.git`, no GHE — Option B) the GitHub-dependent steps are auto-skipped; force either way with `--skip-github` or `SKIP_GITHUB=false`.

**Secrets come from David Majetic — not self-provisioned.** Message **David Majetic (dmajetic@plaid.com)** and request **the completed `.env`** (Anthropic, Plaid sandbox, ElevenLabs, Glean/AskBill, GOOGLE_API_KEY, etc.). There is **no GCP service-account JSON** — Google embeddings use the `GOOGLE_API_KEY` in `.env`.

**Place it correctly (the relative path matters):**
- **`.env` → the repo root**, i.e. `plaid-demo-recorder/.env` (replace the template `install.sh` wrote). The pipeline only reads `.env` from the repo root — a `.env` left in `~/Downloads` or a subfolder will not be found. **The name must be exactly `.env` (leading dot)** — macOS/browsers often save it as `env`, `env.txt`, or `.env.txt`, and then the installer's template silently wins and every key looks "set" but is a placeholder. **Never commit `.env`** (it's gitignored).
  ```bash
  mv ~/Downloads/plaid-demo-recorder.env ./.env      # run from the repo root
  # Verify: file present, NOT still the template, and the key isn't the placeholder
  test -f ./.env && ! cmp -s ./.env ./.env.example \
    && grep -q '^ANTHROPIC_API_KEY=.\+' ./.env \
    && ! grep -q '^ANTHROPIC_API_KEY=sk-ant\.\.\.' ./.env \
    && echo ".env OK at repo root" || echo ".env missing, still the template, or key empty/placeholder"
  ```

**Validate before going further — do not proceed until this passes:**
```bash
npm run pipe -- validate-env    # expect: [env-check] ✓ Required checks passed
npm run pipe -- whoami          # your GHE identity
```
If `validate-env` flags a key, it's missing/blank in the `.env` — re-check you placed **David's** file at the repo root (not the template), or ask David for the specific value. Only `ANTHROPIC_API_KEY` is strictly required for a basic build; everything else degrades gracefully. Full handoff reference: **README §2**.

## 6. MCP servers

> **`.mcp.json` is generated per-machine, not committed.** It holds absolute paths to the stdio MCP servers (AskBill, moviepy) under *your* home dir, so committing it would ship one person's `/Users/<name>/…` paths to everyone (that's what broke AskBill on fresh clones). The repo tracks **`.mcp.json.template`** (with a `__MCP_HOME__` placeholder); `bash scripts/setup/install.sh` renders it to a gitignored `.mcp.json` for your `$HOME` and verifies the AskBill server can launch. **Restart the agent after install** so it loads the servers. To change server wiring, edit the **template** and re-run the installer — never hand-edit `.mcp.json` (the agent can't, and it's regenerated).

**What each server is (plainly):** **AskBill** = a local Python bridge (venv, Python **3.10+**) to Plaid's docs service — provisioned by `install.sh` from the repo's vendored copy, wired in `.mcp.json`; never point `ASKBILL_API_URL` at the raw `wss://hello-finn…` endpoint (it doesn't speak MCP — the mcp-remote bridge hangs). **Pipeline Glean / Solutions Master** = env-driven npm packages used by the headless `research` stage (no local server to install). **Glean Enterprise connector** = Glean's remote MCP server (`https://plaid-be.glean.com/mcp/all-data`, SSO/OAuth, user-scoped in Claude Code) for *interactive* prompt research — separate from pipeline Glean. **moviepy** = render-only (full-pipeline video). **playwright** = browser automation via `npx @playwright/mcp`. **figma** = remote HTTP (nothing local).

**Research MCPs (optional — wired by the install + your `.env`; builds still complete without them, just with less customer color):**
- **AskBill** — Plaid product/API documentation Q&A. Wired via `.mcp.json` (generated from the template at install; the installer provisions the server from `scripts/setup/mcp-servers/askbill-plaid/` and verifies the venv can import its deps). Without it: `[AskBill unavailable]`.
- **Glean (pipeline research)** — `@gleanwork/local-mcp-server`, internal knowledge (Gong calls, collateral, customer stories) used by the pipeline's `research` stage. Enabled by `GLEAN_INSTANCE` + `GLEAN_API_TOKEN` in `.env`. Without it: `[Glean unavailable]`.
- **Glean ENTERPRISE connector (recommended — set this up):** connect Claude Code to **Plaid's Glean Enterprise instance** so the agent has real account context (opportunities, Gong calls, collateral, Slack) *while you draft `inputs/prompt.txt`* — better prompts in, better demos out. **This is a completely separate integration from the pipeline Glean above:** it's Glean's official remote MCP server with managed **SSO/OAuth — no API token, nothing in `.env`** — and it does not touch or replace the pipeline's `GLEAN_API_TOKEN`. Setup (one time):
  ```bash
  ./scripts/setup/connect-glean-enterprise.sh     # registers the server user-scoped (skips if already connected)
  # …or by hand:
  claude mcp add --transport http --scope user glean https://plaid-be.glean.com/mcp/all-data
  # …or via Glean's configurator:
  npx -y @gleanwork/configure-mcp-server remote --url https://plaid-be.glean.com/mcp/all-data --client claude-code
  ```
  Then inside Claude Code: **`/mcp` → `glean` → Authenticate → sign in with Plaid SSO.** (`install.sh` also offers this step interactively.) Try: *"Search Glean for the `<Account>` opportunity and recent Gong calls, then draft `inputs/prompt.txt` for a demo of their use case."*

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

> **Required inputs — the agent asks before it builds.** A successful prompt needs specifics. If your request is vague, the agent will ask a few targeted questions rather than guess. At minimum it needs:
> - **Exact Plaid product(s)** by approved name, resolving to a product family — e.g. **"CRA Base Report" (`cra_base_report`)**, not "a lending demo." Vague asks like *"lending demo,"* *"a fraud thing,"* or *"something with income"* don't pin down the product family that drives research, the Link token, and the API panels — so the agent will ask you to name the exact product (and offer candidates if it's ambiguous).
> - **Host company / brand** (and URL if you have it).
> - **Persona + story/use case** — who's on screen, what they're doing, and the reveal/outcome.
> - **Build mode & depth** — app-only (default) vs with-slides vs full video; research depth (default `gapfill`).
>
> Give these up front and the agent moves straight to the review step; leave them out and it clarifies first. (You don't need to know the family slug — naming the real product, e.g. "CRA Base Report," is enough.)
>
> **You approve before it builds.** Once the agent has the inputs, it shows an easy-to-read summary of the proposed demo — title, host, products, persona, the **story arc**, and the ordered beats — and asks *"Want any changes, or should I build it?"* Tell it what to tweak (a beat, the persona, the reveal, a product) and it revises the summary; it only writes `inputs/prompt.txt` and starts the build once you say go.

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

> **The dashboard opens itself after a build.** When a build stops at build-qa (the default `npm run demo` review point), the pipeline auto-starts the dashboard and opens `http://localhost:4040/?run=<run>` in your browser — no need to ask. (Full-render runs and touch-up re-runs don't auto-open. Turn it off with `PIPELINE_NO_AUTO_OPEN=1`.)

### Slides & JSON panels — opt in or out (just say it)

A build has two **independent** toggles. **Defaults:** you get the **app + the Plaid API/JSON side panels**, and **no slides**. Slides are **opt-in**; the JSON panels are **opt-out**. Say what you want in plain language — the agent maps it to the flags:

| Say this | You get | Behind it |
|---|---|---|
| "Build the &lt;story&gt; demo" | app + JSON panels, no slides *(default)* | `npm run demo` |
| "…**with slides**" / "add the slide deck" | app + JSON panels + slides | `--with-slides` |
| "…**without the API panels**" / "no JSON side panel" | app (+ slides if asked), no panels | `--no-panels` |
| "**app only** — no slides, no API panels" | just the app | `--app-only --no-panels` |
| "**with slides but skip the API panels**" | app + slides, no panels | `--with-slides --no-panels` |
| "build the **full video with slides**" | render + slides | `npm run demo:full --with-slides` |

The **JSON panels** are the Plaid **request/response JSON** shown beside each step; **slides** are the marketing deck interleaved with the app flow. The two are orthogonal — any combination works (e.g. slides-on + panels-off).

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
- **Build halts at the `script` stage, or the run name/`products[]` has a product you didn't intend:** almost always **prompt wording** — see `inputs/prompt-template.txt` → *Authoring Gotchas*. Don't name products you aren't using (even in "N/A"/"do NOT" lines), and reserve the word "insight" for slide steps (a host step named "…insight" is required to have a JSON panel and will halt).
- **Stale clone? Builds now self-update.** `npm run demo` and `npm run pipe -- new` automatically fast-forward a clean clone that's behind `main` before building (they ask first if you have uncommitted changes, and never block the build). So you no longer need to `git pull` by hand before a demo. Opt out with `--no-pull` or `PIPE_SKIP_FRESHNESS=true`.
- **Re-running `bash scripts/setup/install.sh`** is the safe way to refresh deps after a `git pull` (the auto-pull updates code, not npm deps).
- **Architecture & deep rules:** [`CLAUDE.md`](CLAUDE.md). Agent/heartbeat contract: [`AGENTS.md`](AGENTS.md). CLI reference: [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md). Sharing demos: [`docs/distribution-architecture.md`](docs/distribution-architecture.md).
- **Stuck?** Ping the repo owner.
