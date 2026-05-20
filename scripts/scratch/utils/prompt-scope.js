'use strict';

/**
 * Parse explicit demo scope from story-first prompt templates and apply negation-safe
 * keyword rules so disclaimers ("no CRA consumer report …") do not select CRA.
 */

// Known product-family slugs the explicit "Primary product family" prompt field
// may reference. Mirrors PRODUCT_FAMILIES keys in product-profiles.js. When a
// new family is added there, add it here too so prompts can opt into it
// explicitly. The keyword-inference heuristic below intentionally still maps
// most prompts to the legacy `funding | cra_base_report | income_insights` set
// for back-compat; new families only fire when authors set them explicitly.
const KNOWN_FAMILIES = new Set([
  // Legacy / heuristic-mapped:
  'funding',
  'cra_base_report',
  'income_insights',
  // 2026 expansion:
  'bank_income',
  'assets',
  'cra_underwriting',
  'cra_lend_score',
  'cra_network_insights',
  'cra_cashflow_insights',
  'cra_partner_insights',
  'cra_cashflow_updates',
  'cra_home_lending',
  'investments_move',
  'investments',
  'liabilities',
  'transactions',
  'recurring_transactions',
  'enrich',
  'identity_verification',
  'transfer',
  'guaranteed_ach',
  'monitor',
  'plaid_protect',
  'cash_advance_score',
]);

/**
 * @param {string} line
 * @returns {boolean} true if this line mentions CRA/consumer report in a negated / excluded sense
 */
function isNegatedCraMention(line) {
  const lower = String(line || '').toLowerCase();
  const craRe = /\b(cra|consumer\s+report|base\s+report|cra_base_report|cra_income_insights)\b/g;
  let m;
  while ((m = craRe.exec(lower)) !== null) {
    const idx = m.index;
    const before = lower.slice(0, idx);
    const tail = before.slice(Math.max(0, before.length - 120));
    if (/\bno\s+/i.test(tail)) return true;
    if (/\bnot\s+/i.test(tail)) return true;
    if (/\bwithout\s+/i.test(tail)) return true;
    if (/\bexclude\w*/i.test(tail)) return true;
    if (/\bnever\s+/i.test(tail)) return true;
  }
  return false;
}

/**
 * @param {string} line
 */
function isNegatedIncomeInsightsMention(line) {
  const lower = String(line || '').toLowerCase();
  if (!/\b(cra income insights|income insights|cra_income_insights)\b/.test(lower)) return false;
  const idx = lower.search(/\b(cra income insights|income insights|cra_income_insights)\b/);
  if (idx < 0) return false;
  const before = lower.slice(0, idx);
  if (/\bno\s+$/.test(before) || /\bno\s+\S+\s+$/.test(before)) return true;
  if (/\bwithout\s+/.test(before.slice(Math.max(0, before.length - 40)))) return true;
  if (/\bnot\s+/.test(before.slice(Math.max(0, before.length - 24)))) return true;
  return false;
}

/**
 * Strip the Compliance / user data block so keyword scans ignore disclaimer prose.
 * Stops at the next blank line paragraph break, horizontal rule, major **Heading**, or cap length
 * so the rest of the prompt (e.g. Signal demo line) is not removed.
 * @param {string} text
 */
function stripComplianceSection(text) {
  const t = String(text || '');
  const re = /\*\*Compliance \/ user data[^*]*\*\*[^\n]*/gi;
  const m = re.exec(t);
  if (!m) return t;
  const start = m.index;
  const after = t.slice(start + m[0].length);
  const candidates = [
    after.search(/\n\s*\n/),
    after.search(/\n-{3,}\s*\n/),
    after.search(/\n\*\*[A-Za-z]/),
  ].filter((x) => x >= 0);
  let take = candidates.length ? Math.min(...candidates) : Math.min(after.length, 2000);
  if (take < 0) take = Math.min(after.length, 2000);
  const end = start + m[0].length + take;
  return t.slice(0, start) + '\n' + t.slice(end);
}

/**
 * @param {string} raw
 * @returns {'funding'|'cra_base_report'|'income_insights'|null}
 */
function normalizeFamilyCandidate(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^«+/, '').replace(/»+$/, '').trim();
  s = s.replace(/^[`"'“”]+|[`"'“”]+$/g, '').trim();
  s = s.split('\n')[0].trim();
  const lower = s.toLowerCase();
  if (/pick one|aligns with pipeline|pipeline profiles/i.test(lower) && /\|/.test(s)) return null;
  if (/^other\b/.test(lower)) return null;
  // Template placeholder list like "funding | cra_base_report | income_insights | other"
  // — when multiple legacy-family slugs appear with pipes, treat as unfilled.
  if (/\|/.test(s) && /(funding|cra_base_report|income_insights)/i.test(s)) return null;
  // Match any known family slug from KNOWN_FAMILIES (longest-first so e.g.
  // `cra_cashflow_insights` is not shadowed by `cra`). Slugs are case-insensitive
  // and may use either underscore or hyphen separators in author prose.
  const normalized = lower.replace(/[-\s]/g, '_');
  const sortedFamilies = [...KNOWN_FAMILIES].sort((a, b) => b.length - a.length);
  for (const fam of sortedFamilies) {
    const re = new RegExp(`^${fam}\\b`);
    if (re.test(normalized)) return fam;
  }
  return null;
}

/**
 * Read **Primary product family** from a story-first prompt.
 * @param {string} promptText
 * @returns {string|null}  Any slug from KNOWN_FAMILIES, or null when none matches.
 */
function parseExplicitPrimaryProductFamily(promptText) {
  const t = String(promptText || '');
  const hm = t.match(/\*\*Primary product family\*\*[^\n]*/i);
  if (!hm) return null;
  const headingLine = hm[0];
  const afterHeading = t.slice(hm.index + headingLine.length);
  const colonParts = headingLine.split(':');
  const sameLineRest = colonParts.length > 1 ? colonParts.slice(1).join(':').trim() : '';
  let candidate = sameLineRest;
  const nextLine = afterHeading.match(/^\s*\n\s*([^\n]+)/);
  if (nextLine && nextLine[1]) {
    const nl = nextLine[1].trim();
    if (nl) candidate = nl;
  }
  if (!candidate) return null;
  return normalizeFamilyCandidate(candidate);
}

/**
 * Legacy ordered keyword inference (full string, no template / negation). For short fragments
 * (e.g. demoScript fields) where compliance sections do not apply.
 *
 * The order matters — specific endpoint and product names are checked first so a
 * non-CRA Bank Income prompt that mentions "income" doesn't get routed to the
 * `income_insights` (CRA) family by accident. Returns `'generic'` when nothing
 * matches.
 *
 * @param {string} text
 * @returns {string}
 */
function inferProductFamilyFromKeywordsOnly(text = '') {
  const lower = String(text || '').toLowerCase();

  // Non-CRA Bank Income FIRST: the /credit/bank_income/get endpoint is the
  // canonical signal. We check this before the generic "income insights" rule
  // so prompts mentioning "bank income" or that endpoint do not accidentally
  // get routed to the CRA income_insights family (which has a different setup
  // contract and would fail validation).
  if (/\bbank[\s_-]?income\b/.test(lower) || /\/credit\/bank_income\/get\b/.test(lower)) {
    return 'bank_income';
  }

  // CRA Income Insights requires the CRA qualifier or the CRA endpoint to fire.
  // Bare "income insights" without CRA framing is ambiguous and should NOT
  // route to CRA; let the explicit "Primary product family" prompt field win
  // when the author intends CRA.
  if (/\b(cra income insights|cra_income_insights)\b/.test(lower)) {
    return 'income_insights';
  }
  if (/\/cra\/check_report\/income_insights\/get\b/.test(lower)) {
    return 'income_insights';
  }

  if (/\b(base report|consumer report|check base report|cra base report)\b/.test(lower)) {
    return 'cra_base_report';
  }
  if (/\b(signal|auth|identity match|account funding|instant account verification|iav|eav|ach risk)\b/.test(lower)) {
    return 'funding';
  }
  return 'generic';
}

/**
 * True if any non-compliance line has CRA keywords and is not negated.
 * @param {string} promptText
 */
function textHasPositiveCraKeywordSignal(promptText) {
  const scoped = stripComplianceSection(promptText);
  const lines = scoped.split(/\n/);
  const craRe = /\b(base report|consumer report|check base report|cra base report|cra_base_report|cra_income_insights)\b/i;
  const craWord = /\bcra\b/i;
  for (const line of lines) {
    if (isNegatedCraMention(line)) continue;
    if (craRe.test(line) || craWord.test(line)) return true;
  }
  return false;
}

/**
 * True if any line has income-insights keywords and is not negated.
 * @param {string} promptText
 */
function textHasPositiveIncomeInsightsKeywordSignal(promptText) {
  const scoped = stripComplianceSection(promptText);
  const lines = scoped.split(/\n/);
  const re = /\b(cra income insights|income insights|cra_income_insights)\b/i;
  for (const line of lines) {
    if (isNegatedIncomeInsightsMention(line)) continue;
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * Effective product family for a full author prompt: explicit Primary product family wins;
 * otherwise negation-safe keyword pass on text with Compliance section stripped.
 * @param {string} promptText
 * @returns {string}  Any KNOWN_FAMILIES slug, or 'generic'.
 */
function getEffectiveProductFamily(promptText) {
  const explicit = parseExplicitPrimaryProductFamily(promptText);
  // Any explicitly declared known family wins — including the new 2026 families.
  if (explicit && KNOWN_FAMILIES.has(explicit)) {
    return explicit;
  }

  const scoped = stripComplianceSection(promptText);
  if (textHasPositiveIncomeInsightsKeywordSignal(promptText)) {
    return 'income_insights';
  }
  const lines = scoped.split(/\n/);
  for (const line of lines) {
    if (isNegatedCraMention(line)) continue;
    if (/\b(base report|consumer report|check base report|cra base report)\b/i.test(line)) {
      return 'cra_base_report';
    }
    if (/\bcra\b/i.test(line) && !isNegatedCraMention(line)) {
      return 'cra_base_report';
    }
  }
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'funding') {
    return 'funding';
  }
  if (/\b(signal|auth|identity match|account funding|instant account verification|iav|eav|ach risk)\b/i.test(scoped)) {
    return 'funding';
  }
  return 'generic';
}

/**
 * Whether run-name token CRA should appear (orchestrator extractApiTokens).
 * @param {string} promptText
 */
function shouldIncludeCraRunNameToken(promptText) {
  const explicit = parseExplicitPrimaryProductFamily(promptText);
  if (explicit === 'cra_base_report' || explicit === 'income_insights') return true;
  if (explicit === 'funding') return false;
  return textHasPositiveIncomeInsightsKeywordSignal(promptText) || textHasPositiveCraKeywordSignal(promptText);
}

/**
 * Whether PRODUCT_FILE_TRIGGERS may add references/products/cra.md from prompt substring rules.
 * @param {string} promptText
 * @param {string} effectiveFamily from getEffectiveProductFamily
 */
function shouldAllowCraSkillFileTrigger(promptText, effectiveFamily) {
  if (effectiveFamily === 'cra_base_report' || effectiveFamily === 'income_insights') return true;
  if (effectiveFamily === 'funding') return false;
  return textHasPositiveCraKeywordSignal(promptText) || textHasPositiveIncomeInsightsKeywordSignal(promptText);
}

/**
 * Early research slug from full prompt: explicit CRA families win first; otherwise pick the
 * first slug whose keywords appear in the prompt. CRA / income slugs use the same
 * negation- and compliance-aware positive signals as {@link getEffectiveProductFamily}.
 * @param {string} promptContent
 * @returns {string|null}
 */
function detectProductSlugFromPrompt(promptContent) {
  const pc = String(promptContent || '');
  const explicit = parseExplicitPrimaryProductFamily(pc);

  if (explicit === 'cra_base_report') return 'cra-base-report';
  if (explicit === 'income_insights') return 'income-insights';

  const slugChecks = [
    {
      slug: 'income-insights',
      pattern: /\b(cra income insights|income insights|cra_income_insights)\b/i,
      inScope: () => textHasPositiveIncomeInsightsKeywordSignal(pc),
    },
    {
      slug: 'cra-base-report',
      pattern: /\b(base report|consumer report|check base report|cra base report|cra_base_report|cra_income_insights)\b|\bcra\b/i,
      inScope: () => textHasPositiveCraKeywordSignal(pc),
    },
    { slug: 'auth', pattern: /\bauth\b|\baccount.verif|\bIAV\b|\bEAV\b/i, inScope: () => true },
    { slug: 'signal', pattern: /\bsignal\b|\bach.risk\b/i, inScope: () => true },
    { slug: 'layer', pattern: /\blayer\b/i, inScope: () => true },
    { slug: 'idv', pattern: /\bIDV\b|\bidentity.verif/i, inScope: () => true },
    { slug: 'monitor', pattern: /\bmonitor\b/i, inScope: () => true },
    { slug: 'assets', pattern: /\bassets\b/i, inScope: () => true },
    { slug: 'transfer', pattern: /\btransfer\b|\bpay.by.bank\b/i, inScope: () => true },
  ];

  for (const { slug, pattern, inScope } of slugChecks) {
    if (!inScope()) continue;
    if (pattern.test(pc)) return slug;
  }
  return null;
}

module.exports = {
  parseExplicitPrimaryProductFamily,
  isNegatedCraMention,
  isNegatedIncomeInsightsMention,
  stripComplianceSection,
  inferProductFamilyFromKeywordsOnly,
  textHasPositiveCraKeywordSignal,
  textHasPositiveIncomeInsightsKeywordSignal,
  getEffectiveProductFamily,
  shouldIncludeCraRunNameToken,
  shouldAllowCraSkillFileTrigger,
  detectProductSlugFromPrompt,
};
