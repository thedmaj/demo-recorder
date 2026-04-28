'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// build-app.js calls requireRunDir(PROJECT_ROOT, 'build-app') at module load,
// which requires the run dir to be inside <project>/out. Make a stub dir
// there (cleaned up on process exit).
const PROJECT_OUT = path.resolve(__dirname, '../../out');
fs.mkdirSync(PROJECT_OUT, { recursive: true });
const stubRunDir = fs.mkdtempSync(path.join(PROJECT_OUT, 'build-app-test-'));
process.env.PIPELINE_RUN_DIR = stubRunDir;
process.on('exit', () => {
  try { fs.rmSync(stubRunDir, { recursive: true, force: true }); } catch (_) {}
});

const {
  cleanMalformedTestidDuplicates,
  validatePlaywrightTargetsAgainstSteps,
} = require(path.join(__dirname, '../../scripts/scratch/scratch/build-app'));

// Suppress noise from console.warn during tests but keep test output clean.
function silenceWarnings(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); } finally { console.warn = orig; }
}

// ─── cleanMalformedTestidDuplicates ─────────────────────────────────────────

describe('cleanMalformedTestidDuplicates', () => {
  test('strips a second data-testid attribute on a button (LLM hallucination)', () => {
    const html =
      `<button class="btn btn-primary" data-testid="continue-btn" onclick="window.goToStep('next')" ` +
      `data-testid="[data-testid=&quot;continue-btn&quot;]">Continue</button>`;
    const out = silenceWarnings(() => cleanMalformedTestidDuplicates(html));
    assert.equal(out.fixedCount, 1);
    // After cleaning, exactly one data-testid remains:
    assert.equal((out.html.match(/data-testid\s*=/g) || []).length, 1);
    // The first (canonical) attribute is preserved:
    assert.match(out.html, /data-testid="continue-btn"/);
    // The hallucinated selector-string attribute is gone:
    assert.doesNotMatch(out.html, /\[data-testid=/);
  });

  test('leaves clean HTML untouched (idempotent)', () => {
    const html =
      `<button class="btn btn-primary" data-testid="continue-btn" onclick="...">Continue</button>`;
    const out = cleanMalformedTestidDuplicates(html);
    assert.equal(out.fixedCount, 0);
    assert.equal(out.html, html);
  });

  test('counts and strips multiple offenders in the same document', () => {
    const html =
      `<button data-testid="a" data-testid="bogus-a">A</button>` +
      `<button data-testid="b" data-testid="bogus-b">B</button>` +
      `<button data-testid="c">C</button>`;
    const out = silenceWarnings(() => cleanMalformedTestidDuplicates(html));
    assert.equal(out.fixedCount, 2);
    assert.equal((out.html.match(/data-testid\s*=/g) || []).length, 3);
    assert.match(out.html, /data-testid="a"[^>]*>A/);
    assert.match(out.html, /data-testid="b"[^>]*>B/);
    assert.doesNotMatch(out.html, /data-testid="bogus/);
  });

  test('handles single-quoted attribute values', () => {
    const html =
      `<button data-testid='continue-btn' data-testid='bogus-selector'>Continue</button>`;
    const out = silenceWarnings(() => cleanMalformedTestidDuplicates(html));
    assert.equal(out.fixedCount, 1);
    assert.match(out.html, /data-testid='continue-btn'/);
  });

  test('handles malformed input gracefully', () => {
    assert.deepEqual(cleanMalformedTestidDuplicates(null), { html: null, fixedCount: 0 });
    assert.deepEqual(cleanMalformedTestidDuplicates(undefined), { html: undefined, fixedCount: 0 });
    assert.deepEqual(cleanMalformedTestidDuplicates(''), { html: '', fixedCount: 0 });
    assert.deepEqual(cleanMalformedTestidDuplicates(123), { html: 123, fixedCount: 0 });
  });

  test('also cleans malformed <a> and <div> tags (not just <button>)', () => {
    const html =
      `<a data-testid="link-a" data-testid="bogus">link</a>` +
      `<div data-testid="block" data-testid="bogus">block</div>`;
    const out = silenceWarnings(() => cleanMalformedTestidDuplicates(html));
    assert.equal(out.fixedCount, 2);
    assert.match(out.html, /data-testid="link-a"/);
    assert.match(out.html, /data-testid="block"/);
    assert.doesNotMatch(out.html, /data-testid="bogus/);
  });
});

// ─── validatePlaywrightTargetsAgainstSteps ──────────────────────────────────

// Helper: build a Chase-Bank-style HTML fixture with the same drift pattern
// the user reported (each step's CTA is inside its own div, advances to next).
function makeChaseStyleHtml() {
  return `<!doctype html><html><body>
<div data-testid="step-home" class="step active">
  <button class="btn btn-primary" data-testid="get-started-btn" onclick="window.goToStep('ownership-verified')">Get started</button>
</div>
<div data-testid="step-ownership-verified" class="step">
  <button class="btn btn-primary" data-testid="ownership-continue-btn" onclick="window.goToStep('auth-numbers-retrieved')">Continue</button>
</div>
<div data-testid="step-auth-numbers-retrieved" class="step">
  <button class="btn btn-primary" data-testid="auth-continue-btn" onclick="window.goToStep('enter-transfer-amount')">Continue to transfer</button>
</div>
<div data-testid="step-enter-transfer-amount" class="step">
  <button class="btn btn-primary" data-testid="review-transfer-btn" onclick="window.goToStep('signal-risk-check')">Review and submit</button>
  <button class="btn btn-secondary" data-testid="cancel-transfer-btn">Cancel</button>
</div>
<div data-testid="step-signal-risk-check" class="step">
  <button class="btn btn-primary" data-testid="send-transfer-btn" onclick="window.goToStep('transfer-confirmed')">Send $1,500.00</button>
</div>
<div data-testid="step-transfer-confirmed" class="step">
  <button class="btn btn-primary" data-testid="done-btn" onclick="window.goToStep('home')">Done</button>
</div>
</body></html>`;
}

function makeChaseStyleDemoScript() {
  return {
    steps: [
      { id: 'home' },
      { id: 'ownership-verified' },
      { id: 'auth-numbers-retrieved' },
      { id: 'enter-transfer-amount' },
      { id: 'signal-risk-check' },
      { id: 'transfer-confirmed' },
    ],
  };
}

describe('validatePlaywrightTargetsAgainstSteps', () => {
  test('repairs the exact "previous step button" drift the Chase Bank run hit', () => {
    // This is the bug pattern the user reported: every row targets the
    // previous step's button (the one that brought us TO this step) rather
    // than this step's own CTA (the one that takes us to the next step).
    const playwrightScript = {
      steps: [
        { id: 'home',                  action: 'goToStep' },
        { id: 'ownership-verified',    action: 'click', target: '[data-testid="get-started-btn"]', waitMs: 2500 },
        { id: 'auth-numbers-retrieved',action: 'click', target: '[data-testid="ownership-continue-btn"]', waitMs: 2000 },
        { id: 'enter-transfer-amount', action: 'click', target: '[data-testid="auth-continue-btn"]', waitMs: 2000 },
        { id: 'signal-risk-check',     action: 'click', target: '[data-testid="review-transfer-btn"]', waitMs: 2200 },
        { id: 'transfer-confirmed',    action: 'click', target: '[data-testid="send-transfer-btn"]', waitMs: 2500 },
      ],
    };
    const out = silenceWarnings(() =>
      validatePlaywrightTargetsAgainstSteps(playwrightScript, makeChaseStyleDemoScript(), makeChaseStyleHtml())
    );
    // All 5 click rows had drifted targets and all 5 should auto-fix:
    assert.equal(out.fixedCount, 5);
    assert.equal(out.warningCount, 0);

    // Each row now targets the CTA inside its own step:
    const targetByStep = {};
    for (const row of playwrightScript.steps) targetByStep[row.id] = row.target;
    assert.equal(targetByStep['ownership-verified'],     '[data-testid="ownership-continue-btn"]');
    assert.equal(targetByStep['auth-numbers-retrieved'], '[data-testid="auth-continue-btn"]');
    assert.equal(targetByStep['enter-transfer-amount'],  '[data-testid="review-transfer-btn"]');
    assert.equal(targetByStep['signal-risk-check'],      '[data-testid="send-transfer-btn"]');
    assert.equal(targetByStep['transfer-confirmed'],     '[data-testid="done-btn"]');
  });

  test('leaves correctly-targeted rows untouched (idempotent)', () => {
    const playwrightScript = {
      steps: [
        { id: 'ownership-verified',    action: 'click', target: '[data-testid="ownership-continue-btn"]' },
        { id: 'auth-numbers-retrieved',action: 'click', target: '[data-testid="auth-continue-btn"]' },
      ],
    };
    const out = validatePlaywrightTargetsAgainstSteps(playwrightScript, makeChaseStyleDemoScript(), makeChaseStyleHtml());
    assert.equal(out.fixedCount, 0);
    assert.equal(out.warningCount, 0);
  });

  test('warns (does NOT auto-fix) when multiple primary CTAs make the choice ambiguous', () => {
    // When a step has 2+ btn-primary buttons each with their own goToStep,
    // and none matches the next step in the script, the fixer cannot
    // confidently pick one — it must warn and leave the row alone so an
    // author can review.
    const html = `<div data-testid="step-only" class="step">
      <button class="btn btn-primary" data-testid="path-a" onclick="window.goToStep('path-a-target')">Path A</button>
      <button class="btn btn-primary" data-testid="path-b" onclick="window.goToStep('path-b-target')">Path B</button>
    </div>`;
    const playwrightScript = {
      steps: [{ id: 'only', action: 'click', target: '[data-testid="missing-btn"]' }],
    };
    // No "next step" in the script + neither button's goToStep matches one →
    // ambiguous fallback returns null → warning, no auto-fix.
    const demoScript = { steps: [{ id: 'only' }] };
    const out = silenceWarnings(() =>
      validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html)
    );
    assert.equal(out.fixedCount, 0);
    assert.equal(out.warningCount, 1);
    // Target was left as-is so an author can review:
    assert.equal(playwrightScript.steps[0].target, '[data-testid="missing-btn"]');
  });

  test('auto-fixes the LAST step using the primary CTA fallback (no next step in script)', () => {
    // Real-world Chase pattern: the final "transfer-confirmed" step has
    // exactly one primary CTA whose onclick navigates back to "home" (or any
    // other step). Even though that target isn't the "next" step in the
    // script, the fallback picks it as the canonical CTA.
    const html = `<div data-testid="step-final" class="step">
      <button class="btn btn-primary" data-testid="done-btn" onclick="window.goToStep('home')">Done</button>
    </div>`;
    const playwrightScript = {
      steps: [{ id: 'final', action: 'click', target: '[data-testid="bogus-btn"]' }],
    };
    const demoScript = { steps: [{ id: 'final' }] };
    const out = silenceWarnings(() =>
      validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html)
    );
    assert.equal(out.fixedCount, 1);
    assert.equal(out.warningCount, 0);
    assert.equal(playwrightScript.steps[0].target, '[data-testid="done-btn"]');
  });

  test('skips the Plaid Link launch step (owned by normalizeLaunchPlaywrightRow)', () => {
    const html = `<div data-testid="step-link-launch" class="step">
      <button class="btn btn-primary" data-testid="link-external-account-btn" onclick="window.openPlaidLink()">Connect</button>
    </div>
    <div data-testid="step-success" class="step">
      <button class="btn btn-primary" data-testid="continue-btn" onclick="window.goToStep('done')">Continue</button>
    </div>`;
    const playwrightScript = {
      steps: [
        // Launch step has the wrong target, but we deliberately skip it:
        { id: 'link-launch', action: 'click', target: '[data-testid="bogus-target"]' },
        { id: 'success',     action: 'click', target: '[data-testid="bogus-2"]' },
      ],
    };
    const demoScript = {
      steps: [
        { id: 'link-launch', plaidPhase: 'launch' },
        { id: 'success' },
        { id: 'done' },
      ],
    };
    const out = silenceWarnings(() =>
      validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html)
    );
    // The launch row stayed untouched (1 warning), the success row was fixed:
    assert.equal(playwrightScript.steps[0].target, '[data-testid="bogus-target"]');
    assert.equal(out.fixedCount, 1);
    assert.equal(out.warningCount, 1);
  });

  test('ignores non-click rows (goToStep, wait, etc.)', () => {
    const playwrightScript = {
      steps: [
        { id: 'home', action: 'goToStep', target: 'home' },
        { id: 'ownership-verified', action: 'wait', waitMs: 2000 },
      ],
    };
    const out = validatePlaywrightTargetsAgainstSteps(playwrightScript, makeChaseStyleDemoScript(), makeChaseStyleHtml());
    assert.equal(out.fixedCount, 0);
    assert.equal(out.warningCount, 0);
  });

  test('returns zeros gracefully when given empty / malformed input', () => {
    assert.deepEqual(
      validatePlaywrightTargetsAgainstSteps(null, null, null),
      { fixedCount: 0, warningCount: 0 }
    );
    assert.deepEqual(
      validatePlaywrightTargetsAgainstSteps({ steps: [] }, { steps: [] }, ''),
      { fixedCount: 0, warningCount: 0 }
    );
    assert.deepEqual(
      validatePlaywrightTargetsAgainstSteps({ steps: [{ id: 'x', action: 'click', target: '[data-testid="y"]' }] }, { steps: [] }, ''),
      { fixedCount: 0, warningCount: 0 }
    );
  });

  test('prefers .btn-primary over secondary buttons when picking the CTA', () => {
    const html = `<div data-testid="step-confirm" class="step">
      <button class="btn btn-secondary" data-testid="cancel-btn" onclick="window.goToStep('done')">Cancel</button>
      <button class="btn btn-primary" data-testid="confirm-btn" onclick="window.goToStep('done')">Confirm</button>
    </div>`;
    const playwrightScript = {
      steps: [{ id: 'confirm', action: 'click', target: '[data-testid="missing-btn"]' }],
    };
    const demoScript = { steps: [{ id: 'confirm' }, { id: 'done' }] };
    const out = silenceWarnings(() =>
      validatePlaywrightTargetsAgainstSteps(playwrightScript, demoScript, html)
    );
    assert.equal(out.fixedCount, 1);
    // Picked the .btn-primary, not the .btn-secondary:
    assert.equal(playwrightScript.steps[0].target, '[data-testid="confirm-btn"]');
  });
});
