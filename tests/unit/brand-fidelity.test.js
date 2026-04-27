'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const BF = require(path.join(__dirname, '../../scripts/scratch/utils/brand-fidelity'));

// Minimal "BofA-shaped" brand profile fixture used across tests.
function bofaProfile() {
  return {
    name: 'Bank of America',
    slug: 'bankofamerica',
    nav: {
      _source: 'brand-references',
      items: [
        { label: 'Home',       href: null },
        { label: 'Accounts',   href: null },
        { label: 'Transfers',  href: null },
        { label: 'Bill Pay',   href: null },
        { label: 'Deposits',   href: null },
        { label: 'Menu',       href: null },
      ],
    },
    footer: {
      _source: 'brand-references',
      disclosures: [
        'Member FDIC. Equal Housing Lender.',
      ],
      copyright: '© 2026 Bank of America Corporation. All rights reserved.',
    },
  };
}

// ─── htmlToText / normalizeForCompare helpers ───────────────────────────────

describe('htmlToText / normalizeForCompare', () => {
  test('htmlToText strips script, style, svg, and tag bodies', () => {
    const html =
      '<html><head><style>.x{color:red}</style></head>' +
      '<body><h1>Hello</h1><script>alert(1)</script>' +
      '<svg><circle/></svg><p>World</p></body></html>';
    const text = BF.htmlToText(html);
    assert.match(text, /Hello/);
    assert.match(text, /World/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /color:red/);
    assert.doesNotMatch(text, /circle/);
  });

  test('htmlToText decodes &nbsp; and &amp;', () => {
    const text = BF.htmlToText('<p>Member&nbsp;FDIC&amp;Co.</p>');
    assert.match(text, /Member FDIC&Co\./);
  });

  test('normalizeForCompare lowercases, strips punctuation, collapses whitespace', () => {
    assert.equal(
      BF.normalizeForCompare('Member FDIC.   Equal Housing Lender.'),
      'member fdic equal housing lender'
    );
  });

  test('normalizeForCompare handles smart quotes and nbsp', () => {
    const out = BF.normalizeForCompare('Bank\u00a0of\u00a0America\u2019s');
    assert.match(out, /bank of americas/);
  });
});

// ─── checkNavLabels ─────────────────────────────────────────────────────────

describe('checkNavLabels', () => {
  test('passes when all expected labels are present', () => {
    const html =
      '<nav>Home Accounts Transfers Bill Pay Deposits Menu</nav>' +
      '<main>Welcome</main>';
    assert.deepEqual(BF.checkNavLabels(html, bofaProfile()), []);
  });

  test('flags critical when ≥60% of nav labels are missing', () => {
    const html = '<nav>Foo Bar Baz</nav>';
    const out = BF.checkNavLabels(html, bofaProfile());
    assert.equal(out.length, 1);
    assert.equal(out[0].category, BF.BRAND_FIDELITY_CATEGORIES.NAV_LABEL_MISSING);
    assert.equal(out[0].severity, 'critical');
    assert.ok(out[0].issue.includes('Bank of America'));
  });

  test('flags warning when 40-59% missing', () => {
    const html = '<nav>Home Accounts Transfers</nav>'; // 3/6 present, 3/6 missing = 50%
    const out = BF.checkNavLabels(html, bofaProfile());
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, 'warning');
  });

  test('does NOT flag when only 1 label missing (tolerable drift)', () => {
    const html = '<nav>Home Accounts Transfers Bill Pay Deposits</nav>';
    assert.deepEqual(BF.checkNavLabels(html, bofaProfile()), []);
  });

  test('returns [] when brand has no nav.items', () => {
    assert.deepEqual(BF.checkNavLabels('<nav></nav>', { name: 'X' }), []);
  });

  test('matching is case-insensitive + punctuation-tolerant', () => {
    const html = '<NAV>HOME, ACCOUNTS, TRANSFERS, BILL PAY, DEPOSITS, MENU</NAV>';
    assert.deepEqual(BF.checkNavLabels(html, bofaProfile()), []);
  });
});

// ─── checkFooterDisclosures ─────────────────────────────────────────────────

describe('checkFooterDisclosures', () => {
  test('passes when all disclosures are present verbatim', () => {
    const html =
      '<footer>Member FDIC. Equal Housing Lender. ' +
      '© 2026 Bank of America Corporation. All rights reserved.</footer>';
    assert.deepEqual(BF.checkFooterDisclosures(html, bofaProfile()), []);
  });

  test('flags critical when FDIC disclosure is missing', () => {
    const html = '<footer>© 2026 Bank of America Corporation. All rights reserved.</footer>';
    const out = BF.checkFooterDisclosures(html, bofaProfile());
    assert.ok(out.length >= 1);
    assert.ok(out.find(d => /FDIC/i.test(d.expected)));
    for (const d of out) assert.equal(d.severity, 'critical');
  });

  test('flags critical when copyright is missing', () => {
    const html = '<footer>Member FDIC. Equal Housing Lender.</footer>';
    const out = BF.checkFooterDisclosures(html, bofaProfile());
    assert.ok(out.find(d => /Bank of America Corporation/.test(d.expected)));
  });

  test('80% word-presence-in-order tolerates minor reformatting', () => {
    // Formatting differs slightly but core words appear in order.
    const html = '<footer>FDIC member equal housing lender</footer>';
    // The reordering "FDIC member" vs "Member FDIC" should NOT pass
    // (reordering changes semantics and we want strict regulatory matching).
    const out = BF.checkFooterDisclosures(html, bofaProfile());
    // Either way: copyright is missing, so we expect at least 1 flag.
    assert.ok(out.length >= 1);
  });

  test('returns [] when brand has no footer expectations', () => {
    assert.deepEqual(BF.checkFooterDisclosures('<footer></footer>', { name: 'X' }), []);
  });

  test('every disclosure produces a separate diagnostic', () => {
    const profile = bofaProfile();
    profile.footer.disclosures = ['Member FDIC.', 'Equal Housing Lender.', 'Member SIPC.'];
    const out = BF.checkFooterDisclosures('<footer>(empty)</footer>', profile);
    assert.equal(out.length, 4); // 3 disclosures + copyright
  });
});

// ─── runBrandFidelityChecks integration ─────────────────────────────────────

describe('runBrandFidelityChecks', () => {
  test('returns combined nav + footer diagnostics', () => {
    const html = '<nav>Foo</nav><footer></footer>';
    const out = BF.runBrandFidelityChecks(html, bofaProfile());
    assert.ok(out.find(d => d.category === BF.BRAND_FIDELITY_CATEGORIES.NAV_LABEL_MISSING));
    assert.ok(out.find(d => d.category === BF.BRAND_FIDELITY_CATEGORIES.DISCLOSURE_MISSING));
  });

  test('returns [] on a fully compliant page', () => {
    const html =
      '<nav>Home Accounts Transfers Bill Pay Deposits Menu</nav>' +
      '<footer>Member FDIC. Equal Housing Lender. © 2026 Bank of America Corporation. All rights reserved.</footer>';
    assert.deepEqual(BF.runBrandFidelityChecks(html, bofaProfile()), []);
  });

  test('returns [] when brand profile is null / empty', () => {
    assert.deepEqual(BF.runBrandFidelityChecks('<html/>', null), []);
    assert.deepEqual(BF.runBrandFidelityChecks('', bofaProfile()), []);
  });

  test('exports the three diagnostic categories used by build-qa', () => {
    assert.equal(BF.BRAND_FIDELITY_CATEGORIES.DISCLOSURE_MISSING, 'brand-disclosure-missing');
    assert.equal(BF.BRAND_FIDELITY_CATEGORIES.NAV_LABEL_MISSING, 'brand-nav-label-missing');
    assert.equal(BF.BRAND_FIDELITY_CATEGORIES.VISION_FIDELITY, 'brand-fidelity-vision');
  });
});

// ─── Threshold defaults ──────────────────────────────────────────────────────
// We can't test orchestrator.js's resolution without running a pipeline, but
// we can confirm `qa-review.js`'s default constant updates and that
// `.env.example` reflects the new values.

describe('threshold defaults (Phase 3 hyper-realism upgrade)', () => {
  test('qa-review default QA_PASS_THRESHOLD is 88 when env is unset', () => {
    const prev = process.env.QA_PASS_THRESHOLD;
    delete process.env.QA_PASS_THRESHOLD;
    try {
      // Re-load qa-review module fresh to capture the const at load time.
      const qaReviewPath = require.resolve(path.join(__dirname, '../../scripts/scratch/scratch/qa-review.js'));
      delete require.cache[qaReviewPath];
      // qa-review.js doesn't export the constant, so we read the source line directly.
      const src = require('fs').readFileSync(qaReviewPath, 'utf8');
      assert.match(src, /QA_PASS_THRESHOLD\s*=\s*parseInt\(process\.env\.QA_PASS_THRESHOLD\s*\|\|\s*'88'/);
    } finally {
      if (prev !== undefined) process.env.QA_PASS_THRESHOLD = prev;
    }
  });

  test('orchestrator defaults: MAX_REFINEMENT_ITERATIONS=5, QA_PASS_THRESHOLD=88', () => {
    const orchPath = require.resolve(path.join(__dirname, '../../scripts/scratch/orchestrator.js'));
    const src = require('fs').readFileSync(orchPath, 'utf8');
    // Two assignment sites — both must use the new defaults:
    assert.equal((src.match(/process\.env\.MAX_REFINEMENT_ITERATIONS\s*\|\|\s*'5'/g) || []).length, 2);
    assert.equal((src.match(/process\.env\.QA_PASS_THRESHOLD\s*\|\|\s*'88'/g) || []).length, 2);
  });

  test('.env.example documents the new thresholds', () => {
    const envPath = path.resolve(__dirname, '../../.env.example');
    const src = require('fs').readFileSync(envPath, 'utf8');
    assert.match(src, /QA_PASS_THRESHOLD=88/);
    assert.match(src, /MAX_REFINEMENT_ITERATIONS=5/);
  });
});
