'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const QS = require(path.join(__dirname, '../../scripts/scratch/utils/quickstart'));

function makeAnswers(overrides = {}) {
  return {
    brand: 'Bank of America',
    brandDomain: 'bankofamerica.com',
    industry: 'retail-banking',
    industryLabel: 'Retail / consumer banking',
    linkMode: 'embedded',
    products: [QS.findProduct('auth'), QS.findProduct('identity-match'), QS.findProduct('signal')],
    persona: 'Michael Carter, retail banking customer',
    useCase: 'BofA wants to verify external account ownership before allowing high-value ACH transfers, without micro-deposits.',
    researchDepth: 'gapfill',
    buildAfter: true,
    ...overrides,
  };
}

describe('quickstart catalogs', () => {
  test('KNOWN_PRODUCTS contains the demo-pipeline-supported set', () => {
    const slugs = QS.KNOWN_PRODUCTS.map(p => p.slug);
    for (const required of ['auth', 'identity-match', 'signal', 'transfer', 'cra-base-report', 'layer']) {
      assert.ok(slugs.includes(required), `KNOWN_PRODUCTS missing ${required}`);
    }
  });

  test('findProduct is case-insensitive and matches slug or label', () => {
    assert.equal(QS.findProduct('AUTH').slug, 'auth');
    assert.equal(QS.findProduct('Plaid Signal').slug, 'signal');
    assert.equal(QS.findProduct('not-a-product'), null);
    assert.equal(QS.findProduct(''), null);
    assert.equal(QS.findProduct(null), null);
  });

  test('findIndustry resolves id and label', () => {
    assert.equal(QS.findIndustry('lending').id, 'lending');
    assert.equal(QS.findIndustry('Fintech / neobank').id, 'fintech-neobank');
    assert.equal(QS.findIndustry('does-not-exist'), null);
  });

  test('LINK_MODES includes both modal and embedded', () => {
    assert.deepEqual(QS.LINK_MODES.map(m => m.id).sort(), ['embedded', 'modal']);
  });

  test('RESEARCH_DEPTHS covers gapfill / broad / messaging / skip', () => {
    const ids = QS.RESEARCH_DEPTHS.map(d => d.id).sort();
    assert.deepEqual(ids, ['broad', 'gapfill', 'messaging', 'skip']);
  });
});

describe('quickstart slug + run-id helpers', () => {
  test('slugifyForRunId strips diacritics, collapses runs, trims', () => {
    assert.equal(QS.slugifyForRunId('  Bank of América!! '), 'Bank-of-America');
    assert.equal(QS.slugifyForRunId(''), '');
    assert.equal(QS.slugifyForRunId(null), '');
  });

  test('suggestRunId composes a date-prefixed kebab-case id', () => {
    const id = QS.suggestRunId(makeAnswers());
    // YYYY-MM-DD prefix:
    assert.match(id, /^\d{4}-\d{2}-\d{2}-/);
    assert.match(id, /Bank-of-America/);
    assert.match(id, /Auth/);
    assert.match(id, /v1$/);
    // No double dashes:
    assert.doesNotMatch(id, /--/);
  });
});

describe('fillTemplateFromAnswers', () => {
  test('writes wizard header + replaces template placeholders with brand/industry/products', () => {
    const out = QS.fillTemplateFromAnswers(makeAnswers());
    // Wizard header at top:
    assert.match(out, /^WIZARD-COLLECTED INPUT/);
    assert.match(out, /Brand: Bank of America/);
    assert.match(out, /Brand domain: bankofamerica\.com/);
    assert.match(out, /Industry: Retail \/ consumer banking/);
    assert.match(out, /Plaid Link mode: embedded/);
    assert.match(out, /Products: Plaid Auth, Plaid Identity Match, Plaid Signal/);
    assert.match(out, /Use case \(user pitch\): BofA wants to verify/);
    assert.match(out, /STATUS: DRAFT/);
    // Body placeholder substitutions:
    assert.match(out, /Bank of America — Auth \+ Identity Match \+ Signal/);
    assert.match(out, /Canonical URL: https:\/\/bankofamerica\.com/);
    assert.match(out, /Brand URL \(optional\): https:\/\/bankofamerica\.com/);
    assert.match(out, /Plaid Auth, Plaid Identity Match, Plaid Signal/);
    // Storyboard table left blank for the agent to fill:
    assert.match(out, /STORYBOARD BEATS \(ORDER = SCRIPT ORDER, NO SLIDES\)/);
    assert.match(out, /« # \| Beat Type|^\| 1 \| «host\/link\/insight»/m);
  });

  test('keeps placeholders when answers are missing so the research pass can fill them', () => {
    const out = QS.fillTemplateFromAnswers({
      brand: 'AcmeCo',
      products: [QS.findProduct('auth')],
      useCase: 'Open accounts faster.',
      industry: 'other',
      industryLabel: 'Other (specify in pitch)',
    });
    // No domain → keep the optional URL placeholder rather than hardcoding:
    assert.match(out, /Canonical URL: «https:\/\/\.\.\.»/);
    assert.match(out, /Brand URL \(optional\): «https:\/\/\.\.\.»/);
    // Persona is unset, so the wizard header notes that:
    assert.match(out, /Persona: «persona name \+ role»/);
  });

  test('throws if answers missing entirely', () => {
    assert.throws(() => QS.fillTemplateFromAnswers(null), /answers required/);
  });
});

describe('buildResearchTaskMarkdown', () => {
  test('produces an agent-ready handoff with AskBill + Glean sections per product', () => {
    const md = QS.buildResearchTaskMarkdown(makeAnswers(), { buildAfter: true });
    assert.match(md, /# Quickstart research task/);
    // Calls out both MCPs by canonical tool name:
    assert.match(md, /mcp__user-askbill-plaid__ask_bill/);
    assert.match(md, /mcp__user-askbill-plaid__plaid_docs/);
    assert.match(md, /mcp__user-glean_local__chat/);
    // Per-product blocks reference the freshness helper:
    assert.match(md, /isProductVpFresh\('auth', 30\)/);
    assert.match(md, /isProductVpFresh\('signal', 30\)/);
    assert.match(md, /upsertValuePropositionsSection/);
    // Agent instructions mention rewriting prompt.txt:
    assert.match(md, /Rewrite `inputs\/prompt\.txt`/);
    // buildAfter: true → auto-build command rendered:
    assert.match(md, /npm run pipe -- new --app-only/);
    assert.match(md, /opted into "build after research"/);
  });

  test('emits "optional" build instruction when buildAfter is false', () => {
    const md = QS.buildResearchTaskMarkdown(makeAnswers({ buildAfter: false }), { buildAfter: false });
    assert.match(md, /STEP 6 — Build \(optional\)/);
    assert.doesNotMatch(md, /opted into "build after research"/);
  });

  test('uses skip-research build command when researchDepth=skip', () => {
    const md = QS.buildResearchTaskMarkdown(
      makeAnswers({ researchDepth: 'skip' }),
      { buildAfter: true }
    );
    assert.match(md, /npm run pipe -- new --app-only --research=skip/);
  });

  test('handles empty product list with an explicit "pause and ask" instruction', () => {
    const md = QS.buildResearchTaskMarkdown(makeAnswers({ products: [] }), {});
    assert.match(md, /no products selected/);
    assert.match(md, /pause and ask the user/);
  });
});
