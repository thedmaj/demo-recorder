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
  const hm = t.match(/\*\*Primary product family\*\*:?[^\n]*/i);
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

  // Plaid Protect Cash Advance Score (EWA Score) — surfaced via
  // /signal/evaluate as `scores.cash_advance.score`, but it is a DISTINCT
  // product from standard Plaid Signal ACH return-risk scoring. We detect
  // EWA-specific keywords BEFORE the generic 'signal'/'funding' rule so
  // EWA demos don't get misclassified as Signal demos (which would load
  // the wrong product knowledge file and use the wrong score field).
  // Verified via AskBill 2026-05-21: Cash Advance Score is Plaid Protect
  // / Signal-family, NOT a CRA Consumer Report.
  if (
    /\bewa\b/.test(lower) ||
    /\bearned[\s_-]?wage[\s_-]?access\b/.test(lower) ||
    /\bcash[\s_-]?advance\s+score\b/.test(lower) ||
    /\bcash[_-]advance[_-]score\b/.test(lower) ||
    /\bplaid\s+protect\s+cash[\s_-]?advance\b/.test(lower) ||
    /\bscores\.cash_advance(\.score)?\b/.test(lower)
  ) {
    return 'cash_advance_score';
  }

  // Plaid Protect (anti-fraud / Trust Index / ruleset decisioning umbrella).
  // Must be checked AFTER cash_advance_score (EWA demos sometimes name-drop
  // "Plaid Protect" as the parent solution but are tactically EWA, not the
  // bundled Protect story) and BEFORE the generic 'signal'/'funding' rule.
  // Trust Index keywords (including Ti2) route here. Verified via AskBill +
  // Glean (GTM Playbook 2026) on 2026-05-21. See inputs/products/plaid-protect.md.
  if (
    /\bplaid\s+protect\b/.test(lower) ||
    /\btrust\s+index\b/.test(lower) ||
    /\bti2?\b/.test(lower) ||
    /\bprotect\s+ruleset\b/.test(lower) ||
    /\bprotect_transactions\b/.test(lower) ||
    /\bprotect_linked_bank\b/.test(lower)
  ) {
    return 'plaid_protect';
  }

  // Plaid Investments Move (ACATS / ATON brokerage transfer initiation) is a
  // DIFFERENT product from standard Plaid Investments (holdings / transactions
  // data access). Move uses the 'investments_auth' Link product and the
  // /investments/auth/get endpoint; Investments uses 'investments' and the
  // /investments/holdings/get + /investments/transactions/get endpoints.
  // Move detection MUST run before the standard Investments check below so
  // ACATS prompts don't degrade to the data-access family. Verified via
  // AskBill + Glean GTM Playbook (Feb 2026) on 2026-05-21.
  if (
    /\binvestments\s+move\b/.test(lower) ||
    /\bacats\b/.test(lower) ||
    /\baton\b/.test(lower) ||
    /\binvestments_auth\b/.test(lower) ||
    /\/investments\/auth\/get\b/.test(lower) ||
    /\bbroker-?sourced\b/.test(lower) ||
    /\bheld-?away\b/.test(lower) ||
    /\bbrokerage\s+transfer\b/.test(lower) ||
    /\bportfolio\s+transfer\b/.test(lower)
  ) {
    return 'investments_move';
  }
  // Plaid Liabilities (read-only debt data — credit cards / private student
  // loans / mortgages). Non-FCRA. Detection runs AFTER cra_base_report
  // (lending narratives must win) and AFTER investments_move (ACATS-specific)
  // but BEFORE the generic 'investments' check below — because LIT-bundle
  // prompts mention "investments" alongside Liabilities and Liabilities is
  // the more specific intent. Also runs BEFORE the 'funding'/'signal' fallback.
  // Verified via AskBill + Glean (Financial Management Playbook Mar 2026,
  // Liabilities One-Pager Oct 2025) on 2026-05-21.
  // See inputs/products/plaid-liabilities.md.
  if (
    /\bliabilities\b/.test(lower) ||
    /\/liabilities\/get\b/.test(lower) ||
    /\bdebt[\s_-]?(consolidation|paydown|payoff|management)\b/.test(lower) ||
    /\b(credit[\s_-]?card)[\s_-]?(apr|aprs)\b/.test(lower) ||
    /\bmortgage[\s_-]?(refi|refinance|amortization|escrow)\b/.test(lower) ||
    /\b(student[\s_-]?loan)[\s_-]?(refi|refinance|consolidation|payoff)\b/.test(lower) ||
    /\bbalance[\s_-]?transfer[\s_-]?eligibility\b/.test(lower) ||
    /\bnet[\s_-]?worth\s+(view|dashboard|tracker|calculator)\b/.test(lower) ||
    /\blit[\s_-]?bundle\b/.test(lower)
  ) {
    return 'liabilities';
  }

  if (
    /\binvestment\s+holdings\b/.test(lower) ||
    /\/investments\/holdings\/get\b/.test(lower) ||
    /\/investments\/transactions\/get\b/.test(lower) ||
    /\bportfolio\s+(view|allocation|performance)\b/.test(lower) ||
    /\bpfm\b/.test(lower) ||
    (/\binvestments\b/.test(lower) && !/\bmove\b/.test(lower))
  ) {
    return 'investments';
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
  // EWA / Cash Advance Score must be checked BEFORE the generic 'signal' /
  // 'funding' fallback so a prompt mentioning "Plaid Signal" only as a
  // comparative ("EWA Score, not standard Signal ACH return-risk") doesn't
  // get routed to the funding family. See inferProductFamilyFromKeywordsOnly
  // for the canonical EWA pattern list.
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'cash_advance_score') {
    return 'cash_advance_score';
  }
  // Plaid Protect (umbrella) — checked before plain 'signal'/'funding' so the
  // bundled Protect demo doesn't degrade to a standard Signal-only flow.
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'plaid_protect') {
    return 'plaid_protect';
  }
  // Investments Move (ACATS / ATON) before plain 'investments' — the Move
  // flow uses a different Link product string (investments_auth) and a
  // different endpoint (/investments/auth/get). Misrouting causes the
  // generated app to call /investments/holdings/get after Link completes,
  // which has nothing to do with brokerage transfer initiation.
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'investments_move') {
    return 'investments_move';
  }
  // Liabilities BEFORE the generic 'investments' check — LIT-bundle prompts
  // mention "investments" alongside Liabilities and Liabilities is the more
  // specific intent. Also before the 'funding' fallback.
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'liabilities') {
    return 'liabilities';
  }
  if (inferProductFamilyFromKeywordsOnly(scoped) === 'investments') {
    return 'investments';
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
  if (explicit === 'cash_advance_score') return 'ewa-score';
  if (explicit === 'plaid_protect') return 'plaid-protect';
  if (explicit === 'investments_move') return 'investments-move';
  if (explicit === 'investments') return 'investments';
  if (explicit === 'liabilities') return 'liabilities';
  if (explicit === 'cra_cashflow_insights') return 'cra-cashflow-insights';
  if (explicit === 'cra_lend_score') return 'cra-base-report';
  if (explicit === 'cra_network_insights') return 'cra-base-report';
  if (explicit === 'cra_partner_insights') return 'cra-base-report';

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
    // EWA / Cash Advance Score MUST be checked before the generic 'signal'
    // slug below — EWA prompts naturally mention "Plaid Signal" (the
    // underlying delivery endpoint) and would otherwise load
    // inputs/products/plaid-signal.md instead of plaid-ewa-score.md.
    // The response-field path `scores.cash_advance.score` is also a strong
    // EWA signal that we honor here.
    {
      slug: 'ewa-score',
      pattern:
        /\b(ewa|earned[\s_-]?wage[\s_-]?access|cash[\s_-]?advance\s+score|cash[_-]advance[_-]score|plaid\s+protect\s+cash[\s_-]?advance)\b|scores\.cash_advance(\.score)?\b/i,
      inScope: () => true,
    },
    // Plaid Protect (umbrella) must be checked before the generic 'signal'
    // slug — bundled Protect demos mention "Plaid Signal" as a component but
    // load the broader plaid-protect.md knowledge file (Trust Index, IDV,
    // Monitor, ruleset semantics) instead of just plaid-signal.md.
    {
      slug: 'plaid-protect',
      pattern:
        /\b(plaid\s+protect|trust\s+index|ti2|protect\s+ruleset|protect_transactions|protect_linked_bank)\b/i,
      inScope: () => true,
    },
    // Investments Move (ACATS / ATON brokerage transfer initiation) MUST be
    // checked before the standard 'investments' slug — Move uses a different
    // Link product string and a different endpoint. The generic 'transfer'
    // slug also has to come AFTER this so a 'brokerage transfer' prompt
    // doesn't accidentally load plaid-transfer.md.
    {
      slug: 'investments-move',
      pattern:
        /\b(investments\s+move|acats|aton|investments_auth|broker-?sourced|held-?away|brokerage\s+transfer|portfolio\s+transfer)\b|\/investments\/auth\/get\b/i,
      inScope: () => true,
    },
    // Plaid Liabilities — must be checked BEFORE the generic 'investments'
    // and 'auth' slugs. LIT-bundle prompts (Liabilities + Investments +
    // Transactions) mention "investments" / "auth" alongside Liabilities;
    // Liabilities is the more specific intent for PFM / debt-paydown demos.
    // Verified via AskBill + Glean GTM.
    {
      slug: 'liabilities',
      pattern:
        /\b(liabilities|debt[\s_-]?(consolidation|paydown|payoff|management)|credit[\s_-]?card[\s_-]?aprs?|mortgage[\s_-]?(refi|refinance|amortization|escrow)|student[\s_-]?loan[\s_-]?(refi|refinance|consolidation|payoff)|balance[\s_-]?transfer[\s_-]?eligibility|net[\s_-]?worth[\s_-]?(view|dashboard|tracker|calculator)|lit[\s_-]?bundle)\b|\/liabilities\/get\b/i,
      inScope: () => true,
    },
    {
      slug: 'investments',
      pattern:
        /\b(investments|investment\s+holdings|portfolio\s+(view|allocation|performance|holdings)|pfm)\b|\/investments\/(holdings|transactions)\/get\b/i,
      inScope: () => true,
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
