'use strict';
/**
 * Repo freshness for NEW demo builds.
 *
 * A stale local clone silently produces demos with old templates/fixes — the #1
 * onboarding surprise. Before a NEW build, compare the checkout against its
 * tracked upstream and AUTO-PULL when it is SAFE: a clean working tree and a pure
 * fast-forward (behind, not diverged). The user is only involved when a pull
 * would be risky — uncommitted changes or a diverged branch — and even then the
 * build is never blocked.
 *
 *   up to date / offline / ZIP download (no .git) / no upstream → silent no-op.
 *   behind + clean + fast-forward                              → auto-pull (no permission).
 *   behind + dirty or diverged, interactive TTY                → ask permission.
 *   behind + dirty or diverged, agent / non-interactive        → warn, build on current checkout.
 *
 * Opt out entirely with `--no-pull` (callers translate this to opts.skip) or
 * PIPE_SKIP_FRESHNESS=true. PIPE_FRESHNESS_CHECKED=true means an outer wrapper
 * (e.g. `pipe new` before it spawns the orchestrator) already ran this, so skip.
 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

// utils → scratch → scripts → repo root
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');

async function ensureRepoFreshForBuild(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const log = opts.log || ((m) => console.log(m));
  try {
    if (opts.skip || process.env.PIPE_FRESHNESS_CHECKED === 'true' || process.env.PIPE_SKIP_FRESHNESS === 'true') return;
    if (!fs.existsSync(path.join(root, '.git'))) return; // ZIP download — nothing to pull
    const git = (a) => {
      try { return execSync(`git ${a}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
      catch (_) { return null; }
    };
    const upstream = git('rev-parse --abbrev-ref --symbolic-full-name @{u}');
    if (!upstream) return; // no tracking branch to compare against

    // Best-effort quiet fetch; offline / failure → build on local checkout.
    const fetched = spawnSync('git', ['fetch', '--quiet'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
    if (!fetched || fetched.status !== 0) {
      log('[pipe] repo freshness: fetch skipped (offline?) — building on local checkout.');
      return;
    }

    const behind = parseInt(git(`rev-list --count HEAD..${upstream}`) || '0', 10) || 0;
    if (behind === 0) return; // already current

    const ahead = parseInt(git(`rev-list --count ${upstream}..HEAD`) || '0', 10) || 0;
    const dirty = !!git('status --porcelain');
    const interactive = !!process.stdin.isTTY && process.env.SCRATCH_AUTO_APPROVE !== 'true' && !opts.nonInteractive;

    // SAFE: clean tree + pure fast-forward → pull automatically, no permission needed.
    if (!dirty && ahead === 0) {
      log(`[pipe] local clone is ${behind} commit(s) behind ${upstream} — auto-pulling (fast-forward)…`);
      const res = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
      log(res && res.status === 0
        ? `[pipe] ✓ updated to ${git('rev-parse --short HEAD')} — building on latest.`
        : '[pipe] auto-pull failed (see git output) — building on local checkout.');
      return;
    }

    // UNSAFE: a pull could stash/lose work or hit a merge conflict — needs the user.
    const why = dirty ? 'uncommitted local changes' : `a diverged branch (${ahead} local commit(s) not on ${upstream})`;
    log(`[pipe] local clone is ${behind} commit(s) behind ${upstream}, but auto-pull is unsafe — ${why}.`);
    if (!interactive) {
      log('[pipe] non-interactive: NOT pulling — building on the current (possibly stale) checkout.');
      log(`       To update first: ${dirty ? 'git stash && ' : ''}git pull --ff-only`);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise((r) => rl.question(
      dirty
        ? 'Pull latest now? Your uncommitted changes will be stashed and re-applied. [y/N] '
        : 'Pull latest now? (a merge/rebase may be required) [y/N] ',
      (a) => r(String(a || '').trim().toLowerCase())
    ));
    rl.close();
    if (ans === 'y' || ans === 'yes') {
      let stashed = false;
      if (dirty) {
        const s = spawnSync('git', ['stash', 'push', '-u', '-m', 'pipe-auto-pull'], { cwd: root, stdio: 'inherit' });
        stashed = !!(s && s.status === 0);
      }
      const res = spawnSync('git', ['pull', '--ff-only'], { cwd: root, stdio: 'inherit' });
      if (stashed) spawnSync('git', ['stash', 'pop'], { cwd: root, stdio: 'inherit' });
      log(res && res.status === 0 ? '[pipe] ✓ updated — building on latest.' : '[pipe] pull failed — building on local checkout.');
    } else {
      log('[pipe] keeping current checkout.');
    }
  } catch (e) {
    log(`[pipe] repo freshness check skipped (${(e && e.message) || 'error'}).`);
  }
}

module.exports = { ensureRepoFreshForBuild };
