'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DR = require(path.join(__dirname, '../../scripts/scratch/utils/data-realism'));

// ─── checkGenericPlaceholders ───────────────────────────────────────────────

describe('checkGenericPlaceholders', () => {
  test('flags John Doe / Jane Smith persona names', () => {
    const issues = DR.checkGenericPlaceholders({ persona: { name: 'John Doe' } });
    assert.ok(issues.find(i => i.kind === 'persona-placeholder'));
  });

  test('flags example@example.com email', () => {
    const issues = DR.checkGenericPlaceholders({
      persona: { email: 'foo@example.com' },
      steps: [{ visualState: 'Email: example@example.org' }],
    });
    assert.ok(issues.find(i => i.kind === 'email-placeholder'));
  });

  test('flags 555 placeholder phone numbers', () => {
    const issues = DR.checkGenericPlaceholders({
      steps: [{ visualState: 'Phone (415) 555-0123' }],
    });
    assert.ok(issues.find(i => i.kind === 'placeholder-phone'));
  });

  test('flags lorem ipsum text', () => {
    const issues = DR.checkGenericPlaceholders({
      steps: [{ narration: 'Lorem ipsum dolor sit amet' }],
    });
    assert.ok(issues.find(i => i.kind === 'lorem-ipsum'));
  });

  test('returns no issues on clean realistic data', () => {
    const issues = DR.checkGenericPlaceholders({
      persona: { name: 'Michael Carter', email: 'mcarter+demo@gmail.com' },
      steps: [{ visualState: 'BofA dashboard with $4,312.58 in checking' }],
    });
    assert.deepEqual(issues, []);
  });

  test('all generic placeholder issues are critical severity', () => {
    const issues = DR.checkGenericPlaceholders({ persona: { name: 'John Doe' } });
    for (const i of issues) assert.equal(i.severity, 'critical');
  });
});

// ─── checkRoundNumberRatio ──────────────────────────────────────────────────

describe('checkRoundNumberRatio', () => {
  test('flags when more than 60% of amounts are round (.00 or no cents)', () => {
    const issues = DR.checkRoundNumberRatio({
      steps: [{
        visualState: '$2,000 / $500 / $1,500 / $200.00 / $4,312.58',
      }],
    });
    assert.ok(issues.find(i => i.kind === 'round-number-ratio'));
  });

  test('does not flag when amounts have realistic cents', () => {
    const issues = DR.checkRoundNumberRatio({
      steps: [{
        visualState: '$4,312.58 / $1,247.93 / $89.45 / $2,001.05',
      }],
    });
    assert.deepEqual(issues, []);
  });

  test('skips when fewer than 4 amounts are present (too few to be meaningful)', () => {
    const issues = DR.checkRoundNumberRatio({
      steps: [{ visualState: 'Total $500.00' }],
    });
    assert.deepEqual(issues, []);
  });

  test('flags severity is warning, not critical', () => {
    const issues = DR.checkRoundNumberRatio({
      steps: [{ visualState: '$100 $200 $300 $400 $500 $600' }],
    });
    if (issues.length > 0) assert.equal(issues[0].severity, 'warning');
  });
});

// ─── checkPersonaBalanceConsistency ─────────────────────────────────────────

describe('checkPersonaBalanceConsistency', () => {
  test('flags student persona with $250K balance', () => {
    const issues = DR.checkPersonaBalanceConsistency({
      persona: { role: 'college student' },
      steps: [{ visualState: 'Total $250,000.00 in checking' }],
    });
    assert.ok(issues.find(i => i.kind === 'persona-balance-mismatch'));
  });

  test('does NOT flag CFO persona with $500K balance (within band)', () => {
    const issues = DR.checkPersonaBalanceConsistency({
      persona: { role: 'CFO' },
      steps: [{ visualState: 'Net worth $500,000' }],
    });
    assert.deepEqual(issues, []);
  });

  test('skips when persona role does not match any band', () => {
    const issues = DR.checkPersonaBalanceConsistency({
      persona: { role: 'unknown role' },
      steps: [{ visualState: 'Balance $99,999,999' }],
    });
    assert.deepEqual(issues, []);
  });

  test('skips when no amounts are present in the script', () => {
    const issues = DR.checkPersonaBalanceConsistency({
      persona: { role: 'retail banking customer' },
      steps: [{ visualState: 'Welcome screen' }],
    });
    assert.deepEqual(issues, []);
  });

  test('flag severity is warning', () => {
    const issues = DR.checkPersonaBalanceConsistency({
      persona: { role: 'student' },
      steps: [{ visualState: '$1,000,000.00' }],
    });
    if (issues.length > 0) assert.equal(issues[0].severity, 'warning');
  });
});

// ─── checkMaskingFormat ──────────────────────────────────────────────────────

describe('checkMaskingFormat', () => {
  test('flags when script uses different mask style than brand requires', () => {
    const issues = DR.checkMaskingFormat(
      { steps: [{ visualState: 'Account ····7782 visible' }] },
      { name: 'Chase', masking: { pattern: 'bullet-4' } }
    );
    assert.ok(issues.find(i => i.kind === 'masking-format-mismatch'));
  });

  test('passes when script uses brand-required mask style', () => {
    const issues = DR.checkMaskingFormat(
      { steps: [{ visualState: 'Account ••••7782 visible' }] },
      { name: 'BofA', masking: { pattern: 'bullet-4' } }
    );
    assert.deepEqual(issues, []);
  });

  test('skips when no brand profile or no masking pattern is declared', () => {
    assert.deepEqual(DR.checkMaskingFormat({ steps: [] }, null), []);
    assert.deepEqual(DR.checkMaskingFormat({ steps: [] }, { name: 'X' }), []);
  });
});

// ─── checkTransactionFeedRealism ────────────────────────────────────────────

describe('checkTransactionFeedRealism', () => {
  test('flags ≥3 transactions with no real-bank markers', () => {
    const issues = DR.checkTransactionFeedRealism({
      steps: [{
        visualState:
          'DIRECT DEPOSIT $2,000 / COFFEE SHOP $5 / RENT PAYMENT $1,500 / BONUS $500',
      }],
    });
    assert.ok(issues.find(i => i.kind === 'transaction-feed-too-clean'));
  });

  test('passes when transactions use real-bank markers', () => {
    const issues = DR.checkTransactionFeedRealism({
      steps: [{
        visualState:
          'BANK OF AMERICA DES:DIRECT DEP CO ID:9000123456 INDN:CARTER $2,000.00 / ' +
          'POS DEBIT 04/15 STARBUCKS #234 SAN FRANCISCO CA $5.42 / ' +
          'ACH CREDIT FROM PAYROLL $1,500.00',
      }],
    });
    assert.deepEqual(issues, []);
  });

  test('skips when fewer than 3 transactions', () => {
    const issues = DR.checkTransactionFeedRealism({
      steps: [{ visualState: 'DIRECT DEPOSIT $2,000' }],
    });
    assert.deepEqual(issues, []);
  });
});

// ─── runDeterministicChecks (integration) ───────────────────────────────────

describe('runDeterministicChecks', () => {
  test('passes a clean realistic script', () => {
    const out = DR.runDeterministicChecks({
      persona: { name: 'Michael Carter', role: 'retail banking customer', email: 'mcarter@gmail.com' },
      steps: [{
        id: 'home',
        visualState:
          'BofA dashboard. Balance $4,312.58. ' +
          'BANK OF AMERICA DES:DIRECT DEP $2,847.93. POS DEBIT STARBUCKS #234 $5.42. ACH CREDIT $1,500.00.',
      }],
    });
    assert.equal(out.passed, true);
    assert.equal(out.criticalCount, 0);
  });

  test('returns summary with criticalCount + warningCount + passed', () => {
    const out = DR.runDeterministicChecks({
      persona: { name: 'John Doe', role: 'retail banking customer' },
      steps: [{ visualState: '$100 $200 $300 $400 $500' }],
    });
    assert.equal(typeof out.criticalCount, 'number');
    assert.equal(typeof out.warningCount, 'number');
    assert.equal(typeof out.passed, 'boolean');
    assert.ok(Array.isArray(out.issues));
  });
});

// ─── buildDataRealismFixTask ────────────────────────────────────────────────

describe('buildDataRealismFixTask', () => {
  test('renders agent-task md with run id, issues, and orchestrator-driven CTA', () => {
    const det = DR.runDeterministicChecks({
      persona: { name: 'John Doe' },
      steps: [{ visualState: 'Balance $500.00' }],
    });
    const md = DR.buildDataRealismFixTask({
      runId: 'run-test',
      deterministic: det,
      llm: { issues: [], skipped: true, reason: 'no-key' },
      opts: { orchestratorDriven: true },
    });
    assert.match(md, /^# Data-realism issues — run-test/);
    assert.match(md, /paused on a continue-gate/);
    assert.match(md, /npm run pipe -- continue run-test/);
    assert.match(md, /persona-placeholder/);
  });

  test('renders standalone CTA when not orchestrator-driven', () => {
    const det = DR.runDeterministicChecks({
      persona: { name: 'John Doe' },
      steps: [{ visualState: '' }],
    });
    const md = DR.buildDataRealismFixTask({
      runId: 'run-test',
      deterministic: det,
      llm: { issues: [], skipped: true },
    });
    assert.match(md, /npm run pipe -- stage script run-test/);
    assert.doesNotMatch(md, /continue run-test/);
  });
});

// ─── parseDollar / findDollarAmounts utility tests ─────────────────────────

describe('parseDollar / findDollarAmounts', () => {
  test('parseDollar handles common formats', () => {
    assert.equal(DR.parseDollar('$4,312.58'), 4312.58);
    assert.equal(DR.parseDollar('$500'), 500);
    assert.equal(DR.parseDollar('$0.99'), 0.99);
    assert.equal(DR.parseDollar(''), null);
    assert.equal(DR.parseDollar(null), null);
  });

  test('findDollarAmounts pulls every occurrence', () => {
    const amounts = DR.findDollarAmounts('Pay $500 to A and $1,234.56 to B');
    assert.deepEqual(amounts, ['$500', '$1,234.56']);
  });
});

// ─── Brand-references merge integration (smoke) ─────────────────────────────

describe('brand-references seed files', () => {
  test('inputs/brand-references/ has README + at least 5 seed files', () => {
    const dir = path.resolve(__dirname, '../../inputs/brand-references');
    assert.ok(fs.existsSync(dir), 'brand-references directory exists');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    assert.ok(files.includes('README.md'), 'README.md present');
    const seedFiles = files.filter(f => f !== 'README.md');
    assert.ok(seedFiles.length >= 5, `expected ≥5 seed files, found ${seedFiles.length}`);
  });

  test('each seed file declares brand, slug, and last_verified frontmatter', () => {
    const dir = path.resolve(__dirname, '../../inputs/brand-references');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md');
    for (const f of files) {
      const md = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.match(md, /^---/m, `${f} has frontmatter`);
      assert.match(md, /^brand:\s+\S+/m, `${f} declares brand`);
      assert.match(md, /^slug:\s+\S+/m, `${f} declares slug`);
      assert.match(md, /^last_verified:\s+\d{4}-\d{2}-\d{2}/m, `${f} has last_verified date`);
    }
  });
});
