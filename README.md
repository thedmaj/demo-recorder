# Plaid Demo Recorder

Generate hyper-realistic Plaid customer demos — host banking UI, Plaid Link integration, narration, and final MP4 — entirely from a single `inputs/prompt.txt`. Publish finished demos to a shared catalog your Sales Engineering teammates can pull and launch locally.

This README is written for a sales engineer onboarding to the tool for the first time. For the full pipeline architecture, see [`CLAUDE.md`](CLAUDE.md). For the GitHub-Enterprise distribution model, see [`docs/distribution-architecture.md`](docs/distribution-architecture.md).

---

## What this gets you

- A local dashboard at <http://localhost:4040> for editing prompts, watching builds, inspecting demo apps, and managing your shared library.
- A single CLI entry point — `npm run pipe` — for every lifecycle action (build, resume, stage retry, status, publish).
- A centralized library of demos any teammate has published, pullable in one command.
- An optional one-click publish of your own demo to the shared library.

You do **not** need to know git internals, Node internals, or the Plaid SDK to run or publish a demo. The installer handles the plumbing.

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
3. Creates `.env` from `.env.example` if missing (you fill in the API keys after).
4. Verifies you're signed in to GitHub Enterprise via `gh auth status`; offers to run `gh auth login` if not.
5. Resolves and caches your GHE identity to `~/.plaid-demo-recorder/identity.json`.
6. Clones (or `git pull`s) the shared `plaid-demo-apps` artifact repo to `~/.plaid-demo-apps`.
7. Installs Playwright's Chromium browser for the recorder.
8. Prints the quick-start commands.

Run with `--non-interactive` for CI / unattended setup:

```bash
bash scripts/setup/install.sh --non-interactive
```

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
| `GLEAN_API_TOKEN` + `GLEAN_INSTANCE_URL` | optional | Enables Glean-powered research. |
| `PLAID_DEMO_APPS_REPO` | required for publish / pull | SSH URL of the artifact repo. Current deployment: `git@github.plaid.com:dmajetic/plaid-demo-apps.git`. |
| `PLAID_GHE_HOSTNAME` | required for GHE auth | Current deployment: `github.plaid.com`. The installer uses this for `gh auth` and the identity resolver uses it to query the right `gh` host. |

**All of these live in `.env`, which is `.gitignore`d.** The installer will never write real keys to disk from flags.

> Tip: The dashboard's **Config** tab exposes ~30 non-sensitive flags (build strategy, QA gates, research mode, Plaid Link QA behavior, etc.) with hover tooltips. Secrets still live in `.env` — you edit them in your shell, not in the dashboard.

---

## Everyday workflow

### Build a demo

1. Edit [`inputs/prompt.txt`](inputs/prompt.txt). A full example is in [`inputs/prompt-template-app-only.txt`](inputs/prompt-template-app-only.txt). The richer reference with slide support is in [`docs/prompt-examples.md`](docs/prompt-examples.md).
2. Run:
   ```bash
   npm run pipe -- new --app-only --non-interactive
   ```
3. Open <http://localhost:4040> in another terminal with `npm run dashboard` for live visibility. The dashboard shows every stage, every QA score, and a per-card link to the prompt you used.
4. When the run finishes, its demo app lives at `out/demos/<runId>/scratch-app/index.html`. The dashboard's "Demo Apps" tab can launch it in one click.

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
4. The orchestrator wakes up, re-runs `build-qa`, and either passes the run or loops back to step 1. **Max 3 iterations**, no LLM full-app regen at any point.

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

This runs `git pull --ff-only` in BOTH this repo (code) and `~/.plaid-demo-apps` (shared demos). Any demo another engineer has published is now browsable in the dashboard.

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
| **Files** | Read-only browser over the current run's artifacts. |

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
gh auth login --hostname github.plaid.com
cat >> ~/.zshrc <<'EOF'
export PLAID_GHE_HOSTNAME=github.plaid.com
export PLAID_DEMO_APPS_REPO=git@github.plaid.com:dmajetic/plaid-demo-apps.git
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
npm run pipe -- new --app-only           # build a demo
npm run pipe -- publish <run-id>         # share a demo (auto-merges into your namespace)
```

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
| `gh: command not found` | `brew install gh` (macOS) or <https://cli.github.com>. |
| `ffmpeg: command not found` | `brew install ffmpeg` (macOS); record stage will fail without it. |
| `npm install` fails on `playwright` | Re-run `npx playwright install chromium` separately. |
| `pipe whoami` returns no login | `gh auth status --hostname <ghe-host>`; if not signed in, `gh auth login --hostname <ghe-host>`, then re-run `pipe whoami`. |
| Artifact repo clone fails | Confirm `PLAID_DEMO_APPS_REPO` is set and you have read access. Try `git clone <url>` manually to get a real error message. |
| `.env` missing after install | Installer skips existing `.env` files. Delete yours or manually copy from `.env.example`. |

---

## Quick links

- **Pipeline architecture + stage list** → [`CLAUDE.md`](CLAUDE.md)
- **Distribution / publish flow** → [`docs/distribution-architecture.md`](docs/distribution-architecture.md)
- **CLI reference for Claude / agent use** → [`.claude/skills/pipeline-cli/SKILL.md`](.claude/skills/pipeline-cli/SKILL.md)
- **Dashboard UI reference** → open <http://localhost:4040> after `npm run dashboard`
- **Prompt authoring examples** → [`docs/prompt-examples.md`](docs/prompt-examples.md)
