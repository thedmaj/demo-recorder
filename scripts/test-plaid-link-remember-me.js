'use strict';
/**
 * test-plaid-link-remember-me.js
 * Batch test runner for all Plaid Link Remember Me phone number scenarios.
 *
 * Runs each combination headlessly in sequence, writing results to the
 * cumulative inputs/plaid-link-nav-learnings.md file.
 *
 * Scenarios (from plaid-link-sandbox.md § 4):
 *   415-555-0010 — New user (first-time flow)
 *   415-555-0011 — Verified returning user (saved institution)
 *   415-555-0012 — Returning user + new account
 *   415-555-0013 — OAuth returning user
 *   415-555-0014 — New device (extra verification step)
 *   415-555-0015 — Auto-select (single saved institution)
 *
 * Usage:
 *   node scripts/test-plaid-link-remember-me.js
 *   node scripts/test-plaid-link-remember-me.js --phone=415-555-0011   # single scenario
 *   node scripts/test-plaid-link-remember-me.js --delay=8000           # ms between runs
 */

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const { main: runTest, updateLearnings } = require('./test-plaid-link');

// ── Scenario definitions ──────────────────────────────────────────────────────

const SCENARIOS = [
  {
    phone: '415-555-0010',
    tag:   'Remember Me — New user (first-time)',
    notes: 'First-time flow. Expect full flow: phone → OTP → institution search → credentials → accounts.',
  },
  {
    phone: '415-555-0011',
    tag:   'Remember Me — Verified returning user',
    notes: 'Returning user with saved institution. May skip institution search and credentials.',
  },
  {
    phone: '415-555-0012',
    tag:   'Remember Me — Returning + new account',
    notes: 'Returning user adding new account. Expect institution search + credentials flow.',
  },
  {
    phone: '415-555-0013',
    tag:   'Remember Me — OAuth returning user',
    notes: 'OAuth returning user. May redirect to bank OAuth login page.',
  },
  {
    phone: '415-555-0014',
    tag:   'Remember Me — New device (extra verification)',
    notes: 'New device scenario. Expect extra verification step after OTP.',
  },
  {
    phone: '415-555-0015',
    tag:   'Remember Me — Auto-select (single institution)',
    notes: 'Single saved institution — auto-selected, skips institution search.',
  },
];

// ── CLI args ──────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const singlePhone  = args.find(a => a.startsWith('--phone='))?.replace('--phone=', '');
const delayMs      = parseInt(args.find(a => a.startsWith('--delay='))?.replace('--delay=', '') || '5000', 10);
const phoneInToken = args.includes('--phone-in-token'); // also pass phone in link_token/create

const scenariosToRun = singlePhone
  ? SCENARIOS.filter(s => s.phone === singlePhone)
  : SCENARIOS;

if (scenariosToRun.length === 0) {
  console.error(`[Batch] No scenario found for phone: ${singlePhone}`);
  process.exit(1);
}

// ── Batch runner ──────────────────────────────────────────────────────────────

async function runBatch() {
  console.log(`\n📋 Plaid Link Remember Me Batch Test`);
  console.log(`   Running ${scenariosToRun.length} scenario(s) — ${delayMs}ms between each`);
  console.log('━'.repeat(56));

  const summary = [];

  for (let i = 0; i < scenariosToRun.length; i++) {
    const scenario = scenariosToRun[i];
    console.log(`\n[${i + 1}/${scenariosToRun.length}] ${scenario.tag}`);
    console.log(`  Phone: ${scenario.phone} | Note: ${scenario.notes}`);

    let report;
    try {
      report = await runTest({
        institution:   'First Platypus Bank',
        username:      'user_good',
        password:      'pass_good',
        mfaCode:       '1234',
        noVision:      true,
        headless:      true,
        rememberMe:    true,
        phone:         scenario.phone,
        rememberMeOtp: '123456',
        phoneInToken,
        tag:           scenario.tag,
      });
    } catch (err) {
      console.error(`  [Batch] Fatal error for ${scenario.phone}: ${err.message}`);
      report = {
        testedAt:   new Date().toISOString(),
        institution: 'First Platypus Bank',
        username:   'user_good',
        mode:       'css-only',
        headless:   true,
        rememberMe: true,
        phone:      scenario.phone,
        tag:        scenario.tag,
        passed:     0,
        failed:     1,
        total:      1,
        allPass:    false,
        steps:      [{ step: 'FATAL', success: false, note: err.message }],
        plaidEvents: [],
        plaidResult: null,
      };
      updateLearnings(report);
    }

    summary.push({
      phone:   scenario.phone,
      tag:     scenario.tag,
      passed:  report.passed,
      total:   report.total,
      allPass: report.allPass,
      outcome: report.plaidResult?.success
        ? 'onSuccess'
        : report.plaidResult?.exited
          ? `onExit (${report.plaidResult.err?.error_code || 'user exit'})`
          : 'timeout',
    });

    // Pause between runs to avoid Plaid rate limits / session conflicts
    if (i < scenariosToRun.length - 1) {
      console.log(`\n  [Batch] Waiting ${delayMs}ms before next scenario...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // ── Final summary ────────────────────────────────────────────────────────

  console.log('\n' + '━'.repeat(56));
  console.log('📊 Batch Summary');
  console.log('━'.repeat(56));
  for (const r of summary) {
    const icon    = r.allPass ? '✅' : '❌';
    const score   = `${r.passed}/${r.total}`;
    console.log(`${icon} ${r.phone}  ${score.padEnd(6)}  ${r.outcome.padEnd(20)}  ${r.tag}`);
  }

  // Write batch summary to learnings
  const LEARNINGS_FILE = path.join(__dirname, '../inputs/plaid-link-nav-learnings.md');
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const batchEntry = `
## Batch Summary: Remember Me — ${date}
| Phone | Tag | Result | Outcome |
|-------|-----|--------|---------|
${summary.map(r => `| \`${r.phone}\` | ${r.tag} | ${r.passed}/${r.total} ${r.allPass ? '✅' : '❌'} | ${r.outcome} |`).join('\n')}

---
`;
  const existing = fs.existsSync(LEARNINGS_FILE) ? fs.readFileSync(LEARNINGS_FILE, 'utf8') : '';
  fs.writeFileSync(LEARNINGS_FILE, existing + batchEntry);
  console.log(`\n[Batch] Summary appended to ${LEARNINGS_FILE}`);

  const allPassed = summary.every(r => r.allPass);
  process.exit(allPassed ? 0 : 1);
}

runBatch().catch(err => {
  console.error('[Batch] Fatal:', err.message);
  process.exit(1);
});
