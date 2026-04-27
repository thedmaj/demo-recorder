'use strict';
/**
 * brand-fidelity.js
 *
 * Deterministic checks that the rendered host app actually looks like a
 * real customer's product (right nav labels, verbatim regulatory text in
 * the footer). Runs in `build-qa` after the Playwright walkthrough; pushes
 * `brand-disclosure-missing` and `brand-nav-label-missing` diagnostics
 * when the profile declares expectations that the HTML doesn't satisfy.
 *
 * Phase 3 ships these deterministic checks. A future iteration can add a
 * vision-LLM "does this look like real $brand online banking?" sub-check
 * (the diagnostic categories registered here will accept those too).
 *
 * Pure functions, no I/O — easy to unit-test.
 */

// Diagnostic categories — must be added to DETERMINISTIC_BLOCKER_CATEGORIES
// in build-qa.js so missing brand fidelity blocks the QA gate.
const BRAND_FIDELITY_CATEGORIES = Object.freeze({
  DISCLOSURE_MISSING: 'brand-disclosure-missing',
  NAV_LABEL_MISSING:  'brand-nav-label-missing',
  VISION_FIDELITY:    'brand-fidelity-vision', // reserved for future LLM sub-check
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  // Strip <script>/<style>/<svg> blocks first, then tag-strip. Cheap and
  // good enough for "is this disclosure text present somewhere on the
  // page?" — we are NOT trying to parse layout.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'") // smart quotes → straight
    .replace(/[\u00a0]/g, ' ')                    // nbsp → space
    .replace(/[.,;:!?'"()\[\]]/g, '')             // strip punctuation that varies
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Check: nav labels ──────────────────────────────────────────────────────

/**
 * Verify that the host HTML's nav contains the labels declared in
 * `brandProfile.nav.items[]`. Returns an array of diagnostics — one per
 * missing label, capped to a handful so we don't spam the report when the
 * brand profile is wrong rather than the build is wrong.
 *
 * Nav-label matching is case-insensitive + punctuation-tolerant. We require
 * AT LEAST 60% of the expected labels to appear in the rendered HTML's
 * text — anything below that suggests the LLM invented a different nav.
 */
function checkNavLabels(html, brandProfile, opts = {}) {
  if (!brandProfile || !brandProfile.nav || !Array.isArray(brandProfile.nav.items)) return [];
  const expected = brandProfile.nav.items.map(it => (it && it.label) || '').filter(Boolean);
  if (expected.length === 0) return [];

  const text = normalizeForCompare(htmlToText(html));
  const missing = [];
  for (const label of expected) {
    const needle = normalizeForCompare(label);
    if (!needle) continue;
    if (!text.includes(needle)) missing.push(label);
  }
  // Don't report on every label — just summarize when too many are missing.
  // Threshold: ≥ 40% missing → flag as a single diagnostic.
  const missingRatio = missing.length / expected.length;
  if (missingRatio < 0.4 && missing.length <= 1) return []; // tolerable drift

  const diagnostic = {
    stepId: opts.stepId || 'host-app',
    category: BRAND_FIDELITY_CATEGORIES.NAV_LABEL_MISSING,
    severity: missingRatio >= 0.6 ? 'critical' : 'warning',
    issue:
      `Host nav is missing expected labels for "${brandProfile.name || brandProfile.slug || 'brand'}". ` +
      `Missing: ${missing.slice(0, 6).map(l => `"${l}"`).join(', ')}` +
      (missing.length > 6 ? ` and ${missing.length - 6} more` : ''),
    suggestion:
      `Real ${brandProfile.name || 'brand'} online banking shows these nav items: ` +
      `${expected.join(' | ')}. Update the host app's <nav> to use these EXACT labels in this order.`,
    expectedLabels: expected,
    missingLabels: missing,
    expectedSource: brandProfile.nav._source || 'auto-crawl',
  };
  return [diagnostic];
}

// ─── Check: footer regulatory disclosures ───────────────────────────────────

/**
 * Verify that the host HTML contains the verbatim regulatory disclosures
 * declared in `brandProfile.footer`. Each missing disclosure produces a
 * separate diagnostic — these are individually critical (a bank app shipping
 * without an FDIC notice is a real legal problem).
 *
 * Matching is case-insensitive + punctuation-tolerant but otherwise
 * literal — we are explicitly NOT allowing paraphrase here. "Member FDIC"
 * is not "FDIC member"; "Equal Housing Lender" is not "equal-housing
 * lender" with a hyphen.
 */
function checkFooterDisclosures(html, brandProfile, opts = {}) {
  if (!brandProfile || !brandProfile.footer) return [];
  const footer = brandProfile.footer;
  const expectedStrings = [
    ...(Array.isArray(footer.disclosures) ? footer.disclosures : []),
  ];
  if (footer.copyright) expectedStrings.push(footer.copyright);
  if (footer.nmlsId) expectedStrings.push(footer.nmlsId);
  if (expectedStrings.length === 0) return [];

  const text = normalizeForCompare(htmlToText(html));
  const diagnostics = [];
  for (const expected of expectedStrings) {
    const needle = normalizeForCompare(expected);
    if (!needle) continue;
    if (text.includes(needle)) continue;
    // Be a bit lenient: if at least 80% of the disclosure's words are present
    // in the same order, accept (catches cases where a single character or
    // year was reformatted).
    const words = needle.split(' ').filter(w => w.length > 2);
    const presentInOrder = (() => {
      let cursor = 0;
      let hits = 0;
      for (const w of words) {
        const idx = text.indexOf(w, cursor);
        if (idx >= 0) { hits++; cursor = idx + w.length; }
      }
      return words.length > 0 ? hits / words.length : 0;
    })();
    if (presentInOrder >= 0.8) continue;

    diagnostics.push({
      stepId: opts.stepId || 'host-app',
      category: BRAND_FIDELITY_CATEGORIES.DISCLOSURE_MISSING,
      severity: 'critical',
      issue:
        `Host app is missing the verbatim ${brandProfile.name || 'brand'} ` +
        `regulatory disclosure: "${expected}".`,
      suggestion:
        `Add this string verbatim to a footer rendered on at least one host screen: ` +
        `"${expected}". Do NOT paraphrase — this is regulatory text.`,
      expected,
      expectedSource: footer._source || 'auto-crawl',
    });
  }
  return diagnostics;
}

// ─── Top-level runner ──────────────────────────────────────────────────────

/**
 * Run every deterministic brand-fidelity check against `html` for a
 * given brand profile. Returns a flat array of diagnostic objects ready
 * to be appended to build-qa's `diagnostics` array.
 */
function runBrandFidelityChecks(html, brandProfile, opts = {}) {
  if (!html || !brandProfile) return [];
  return [
    ...checkNavLabels(html, brandProfile, opts),
    ...checkFooterDisclosures(html, brandProfile, opts),
  ];
}

module.exports = {
  runBrandFidelityChecks,
  checkNavLabels,
  checkFooterDisclosures,
  htmlToText,
  normalizeForCompare,
  BRAND_FIDELITY_CATEGORIES,
};
