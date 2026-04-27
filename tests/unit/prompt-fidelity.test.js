'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PF = require(path.join(__dirname, '../../scripts/scratch/utils/prompt-fidelity'));

// ─── extractPromptEntities ───────────────────────────────────────────────────

describe('extractPromptEntities', () => {
  test('pulls brand from various Company / Customer / Brand / Host: lines', () => {
    const cases = [
      ['**Company:** Bank of America', 'Bank of America'],
      ['Company: Chase', 'Chase'],
      ['**Customer:** Wells Fargo', 'Wells Fargo'],
      ['**Brand:** Capital One', 'Capital One'],
      ['Company / context: Vanguard', 'Vanguard'],
      ['Host: SoFi — fintech / neobank', 'SoFi'],
    ];
    for (const [text, expected] of cases) {
      assert.equal(PF.extractPromptEntities(text).brand, expected, `failed on: ${text}`);
    }
  });

  test('falls back to brand domain root when no Brand: line is present', () => {
    const e = PF.extractPromptEntities('Brand URL: https://www.bankofamerica.com/cards');
    assert.equal(e.brand, 'bankofamerica');
    assert.equal(e.brandDomain, 'bankofamerica.com');
  });

  test('extracts persona name + role from "Name / role:" pattern', () => {
    const e = PF.extractPromptEntities('**Name / role:** Michael Carter, retail banking customer');
    assert.equal(e.persona.name, 'Michael Carter');
    assert.equal(e.persona.role, 'retail banking customer');
  });

  test('extracts persona from "Persona:" line', () => {
    const e = PF.extractPromptEntities('Persona: Sarah Lee, CFO');
    assert.equal(e.persona.name, 'Sarah Lee');
    assert.equal(e.persona.role, 'CFO');
  });

  test('persona without comma parses name only', () => {
    const e = PF.extractPromptEntities('Persona: Alex Chen');
    assert.equal(e.persona.name, 'Alex Chen');
    assert.equal(e.persona.role, null);
  });

  test('extracts declared products and strips markdown emphasis', () => {
    const e = PF.extractPromptEntities('**Products used:** Auth, Identity Match, Signal');
    assert.deepEqual(e.products, ['auth', 'identity-match', 'signal']);
    assert.deepEqual(e.productLabels, ['Auth', 'Identity Match', 'Signal']);
  });

  test('falls back to keyword scan when no declared list', () => {
    const e = PF.extractPromptEntities('We will use Auth and Signal in this demo.');
    assert.ok(e.products.includes('auth'));
    assert.ok(e.products.includes('signal'));
  });

  test('Layer is only added from declared list, not keyword scan', () => {
    const free = PF.extractPromptEntities('The user moves through a layer of approvals.');
    assert.ok(!free.products.includes('layer'));
    const declared = PF.extractPromptEntities('Products: Layer, Auth');
    assert.ok(declared.products.includes('layer'));
  });

  test('extracts dollar amounts including cents and commas', () => {
    const e = PF.extractPromptEntities('Transfers $4,312.58 and $500 — also $0.99 fee.');
    assert.ok(e.amounts.includes('$4,312.58'));
    assert.ok(e.amounts.includes('$500'));
    assert.ok(e.amounts.includes('$0.99'));
  });

  test('detects Plaid Link mode from explicit line and from prose hints', () => {
    assert.equal(PF.extractPromptEntities('**Plaid Link mode:** embedded').plaidLinkMode, 'embedded');
    assert.equal(PF.extractPromptEntities('Plaid Link mode: modal').plaidLinkMode, 'modal');
    assert.equal(PF.extractPromptEntities('Use the embedded institution search widget.').plaidLinkMode, 'embedded');
    assert.equal(PF.extractPromptEntities('No mention of link mode here.').plaidLinkMode, null);
  });

  test('extracts use case from multiple template patterns', () => {
    const cases = [
      '**Use case:** BofA wants to verify external account ownership before transfers.',
      'Use case (user pitch): BofA wants to verify external account ownership before transfers.',
      '**User journey (one sentence):** BofA wants to verify external account ownership before transfers.',
    ];
    for (const text of cases) {
      const e = PF.extractPromptEntities(text);
      assert.match(e.useCase || '', /BofA wants to verify external account ownership/);
    }
  });

  test('returns shape with all keys present even on empty input', () => {
    const e = PF.extractPromptEntities('');
    assert.equal(e.brand, null);
    assert.deepEqual(e.products, []);
    assert.deepEqual(e.amounts, []);
    assert.equal(e.plaidLinkMode, null);
    assert.equal(e.useCase, null);
    assert.equal(e.persona.name, null);
  });

  test('handles null / undefined gracefully', () => {
    assert.doesNotThrow(() => PF.extractPromptEntities(null));
    assert.doesNotThrow(() => PF.extractPromptEntities(undefined));
  });
});

// ─── detectStoryboardTier ────────────────────────────────────────────────────

describe('detectStoryboardTier', () => {
  test('tier=verbatim when a markdown table with Beat header is present', () => {
    const text =
      `| # | Beat Type | What the viewer sees |\n` +
      `|---|-----------|----------------------|\n` +
      `| 1 | host | Dashboard |\n` +
      `| 2 | link | Plaid Link |\n` +
      `| 3 | host | Success |`;
    const t = PF.detectStoryboardTier(text);
    assert.equal(t.tier, 'verbatim');
    assert.ok(t.signals.includes('storyboard_table'));
  });

  test('tier=verbatim when "Storyboard:" heading + numbered list ≥3', () => {
    const text =
      `Brand: Acme\n\n` +
      `## Storyboard\n` +
      `1. User opens dashboard\n` +
      `2. User clicks add account\n` +
      `3. User completes Plaid Link\n` +
      `4. User sees confirmation`;
    const t = PF.detectStoryboardTier(text);
    assert.equal(t.tier, 'verbatim');
    assert.equal(t.beatList.length, 4);
    assert.match(t.beatList[0], /User opens dashboard/);
  });

  test('tier=scenario-derived when brand+products+useCase present but no beats', () => {
    const text =
      `Company: Bank of America\n` +
      `Products used: Auth, Identity Match\n` +
      `Use case (user pitch): BofA wants to verify external account ownership before high-value ACH transfers, without micro-deposits.\n`;
    const t = PF.detectStoryboardTier(text);
    assert.equal(t.tier, 'scenario-derived');
    assert.ok(t.signals.includes('use_case_line'));
    assert.match(t.scenarioContext.useCase, /external account ownership/);
  });

  test('tier=scenario-derived also fires on a long scenario sentence (no Use case: line)', () => {
    const text =
      `**Company:** Bank of America\n` +
      `**Products used:** Auth, Signal\n\n` +
      `Bank of America wants to verify external account ownership before allowing high-value ACH ` +
      `transfers, without forcing customers to wait three business days for micro-deposits to settle ` +
      `and reducing operational fraud risk.`;
    const t = PF.detectStoryboardTier(text);
    assert.equal(t.tier, 'scenario-derived');
    assert.ok(t.signals.includes('scenario_sentence'));
    assert.match(t.scenarioContext.scenarioSentence || '', /Bank of America wants to verify/);
  });

  test('tier=generic when only brand+products are present (no scenario)', () => {
    const text = `Company: Bank of America\nProducts used: Auth`;
    const t = PF.detectStoryboardTier(text);
    assert.equal(t.tier, 'generic');
  });

  test('tier=generic on an empty / minimal prompt', () => {
    assert.equal(PF.detectStoryboardTier('').tier, 'generic');
    assert.equal(PF.detectStoryboardTier('Just write any demo').tier, 'generic');
  });

  test('numbered list alone (no storyboard heading) does NOT promote to verbatim', () => {
    // Setup checklist with numbered items should NOT be misread as a storyboard.
    const text =
      `Company: Acme\n\n` +
      `Pre-flight checklist:\n` +
      `1. Set sandbox creds\n` +
      `2. Pick persona\n` +
      `3. Connect bank account`;
    const t = PF.detectStoryboardTier(text);
    assert.notEqual(t.tier, 'verbatim');
  });
});

// ─── compareEntitiesToScript ─────────────────────────────────────────────────

function makeBaselineScript(over = {}) {
  return {
    persona: { name: 'Michael Carter', company: 'Bank of America' },
    plaidLinkMode: 'embedded',
    steps: [
      { id: 'home',    label: 'Dashboard',       visualState: 'BofA dashboard with $4,312.58 balance.', narration: 'Michael opens his BofA account.' },
      { id: 'launch',  label: 'Connect',         visualState: 'Plaid Link embedded widget visible.',     narration: 'Michael clicks Connect to verify ownership via Plaid Auth.' },
      { id: 'success', label: 'Verified',        visualState: 'Success card with masked account.',       narration: 'Plaid Identity Match confirms his name. Signal returns ACCEPT.' },
    ],
    ...over,
  };
}

describe('compareEntitiesToScript', () => {
  test('passes when entities and script are aligned', () => {
    const entities = PF.extractPromptEntities(
      `Company: Bank of America\n` +
      `Persona: Michael Carter, retail banking customer\n` +
      `Products: Auth, Identity Match, Signal\n` +
      `Plaid Link mode: embedded\n` +
      `Use case: $4,312.58 verification flow.\n`
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript());
    assert.equal(cmp.passed, true);
    assert.equal(cmp.criticalCount, 0);
    assert.equal(cmp.score, 100);
  });

  test('flags brand-mismatch as critical', () => {
    const entities = PF.extractPromptEntities('Company: Bank of America\nProducts: Auth');
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript({
      persona: { name: 'Michael Carter', company: 'Capital One' },
    }));
    assert.equal(cmp.passed, false);
    const drift = cmp.drifts.find(d => d.kind === 'brand-mismatch');
    assert.ok(drift, 'expected brand-mismatch drift');
    assert.equal(drift.severity, 'critical');
  });

  test('flags persona-mismatch when first name differs', () => {
    const entities = PF.extractPromptEntities(
      'Company: Bank of America\nPersona: Michael Carter\nProducts: Auth'
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript({
      persona: { name: 'Sarah Lee', company: 'Bank of America' },
    }));
    const drift = cmp.drifts.find(d => d.kind === 'persona-mismatch');
    assert.ok(drift, 'expected persona-mismatch drift');
    assert.equal(drift.severity, 'critical');
  });

  test('flags product-missing when prompt lists a product the script never references', () => {
    const entities = PF.extractPromptEntities(
      'Company: Bank of America\nProducts: Auth, Identity Match, Signal, Layer'
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript());
    const drift = cmp.drifts.find(d => d.kind === 'product-missing');
    assert.ok(drift, 'expected product-missing drift for Layer');
    assert.equal(drift.severity, 'critical');
  });

  test('flags plaidLinkMode mismatch as critical', () => {
    const entities = PF.extractPromptEntities(
      'Company: Bank of America\nProducts: Auth\nPlaid Link mode: modal'
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript()); // script says embedded
    const drift = cmp.drifts.find(d => d.kind === 'plaid-link-mode-mismatch');
    assert.ok(drift);
    assert.equal(drift.severity, 'critical');
  });

  test('flags amount-missing as warning (not critical)', () => {
    const entities = PF.extractPromptEntities(
      'Company: Bank of America\nProducts: Auth\nUser journey: transfer $9,999.99 to savings.'
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript()); // script has $4,312.58, not $9,999.99
    const drift = cmp.drifts.find(d => d.kind === 'amount-missing');
    assert.ok(drift);
    assert.equal(drift.severity, 'warning');
    // Warnings do not flip passed=false on their own:
    const onlyWarnings = cmp.drifts.every(d => d.severity === 'warning');
    if (onlyWarnings) assert.equal(cmp.passed, true);
  });

  test('score deducts 20 per critical and 5 per warning, floor 0', () => {
    const entities = PF.extractPromptEntities(
      'Company: Capital One\nPersona: Sarah Lee\nProducts: Layer\nPlaid Link mode: modal\nUse case: $9,999.99 transfer.'
    );
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript());
    // Many critical drifts → score should be near 0:
    assert.ok(cmp.score < 80);
    assert.ok(cmp.criticalCount >= 3);
    assert.equal(cmp.passed, false);
  });

  test('handles empty or null demoScript gracefully', () => {
    const entities = PF.extractPromptEntities('Company: Acme\nProducts: Auth');
    const cmp = PF.compareEntitiesToScript(entities, null);
    assert.ok(Array.isArray(cmp.drifts));
    // Should at least flag brand-missing:
    assert.ok(cmp.drifts.some(d => d.kind === 'brand-missing'));
  });
});

// ─── buildFidelityFixTask ────────────────────────────────────────────────────

describe('buildFidelityFixTask', () => {
  test('renders agent-task md with run id, drifts, and orchestrator-driven CTA', () => {
    const entities = PF.extractPromptEntities('Company: BofA\nProducts: Auth');
    const cmp = PF.compareEntitiesToScript(entities, { persona: { company: 'Capital One' } });
    const tier = PF.detectStoryboardTier('Company: BofA\nProducts: Auth');
    const md = PF.buildFidelityFixTask({
      runId: 'run-test',
      entities,
      comparison: cmp,
      storyboardTier: tier,
      opts: { orchestratorDriven: true },
    });
    assert.match(md, /^# Prompt-fidelity drift detected — run-test/);
    assert.match(md, /paused on a continue-gate/);
    assert.match(md, /npm run pipe -- continue run-test/);
    assert.match(md, /brand-mismatch/);
    assert.doesNotMatch(md, /npm run pipe -- stage script/);
  });

  test('renders standalone CTA when not orchestrator-driven', () => {
    const entities = PF.extractPromptEntities('Company: BofA\nProducts: Auth');
    const cmp = PF.compareEntitiesToScript(entities, { persona: { company: 'Capital One' } });
    const tier = PF.detectStoryboardTier('Company: BofA\nProducts: Auth');
    const md = PF.buildFidelityFixTask({
      runId: 'run-test',
      entities,
      comparison: cmp,
      storyboardTier: tier,
    });
    assert.match(md, /npm run pipe -- stage script run-test/);
    assert.doesNotMatch(md, /npm run pipe -- continue/);
  });

  test('includes the storyboard tier and signals in the header', () => {
    const text = '**Company:** BofA\n**Products used:** Auth\n\n## Storyboard\n1. a\n2. b\n3. c';
    const entities = PF.extractPromptEntities(text);
    const cmp = PF.compareEntitiesToScript(entities, makeBaselineScript());
    const tier = PF.detectStoryboardTier(text, { entities });
    const md = PF.buildFidelityFixTask({
      runId: 'run-test',
      entities,
      comparison: cmp,
      storyboardTier: tier,
    });
    assert.match(md, /Story tier:.*verbatim/);
  });
});
