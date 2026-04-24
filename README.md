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

### Resume a failed run

```bash
npm run pipe -- status                              # see where it failed
npm run pipe -- resume <run-id> --from=<stage>      # pick up from that stage
npm run pipe -- stage <stage-name> <run-id>         # re-run one stage in place
```

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
