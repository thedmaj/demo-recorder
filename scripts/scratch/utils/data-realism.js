'use strict';
/**
 * data-realism.js
 *
 * Pure helpers for the `data-realism-check` stage. Catches sample-data
 * problems that LLM-only generation tends to produce:
 *
 *   - Generic placeholder names (John Doe, Jane Smith, test@example.com)
 *   - Round dollar amounts (everything ending in .00 looks fake)
 *   - Persona income vs. balances that aren't internally consistent
 *   - Account / card masking patterns that don't match the brand
 *   - Currency / date format that drifts from the brand's locale
 *   - Transaction descriptions that look like a synthetic flow rather than
 *     a real bank's posted-transaction feed
 *
 * The deterministic checks here are cheap; the optional Haiku rubric runs
 * one short LLM call per step to grade transaction-feed realism. Both
 * paths produce the same `issues[]` shape so callers stay backend-agnostic.
 */

// ─── Catalog: occupation → plausible US monthly income range ────────────────
//
// Used to flag persona/balance combos that don't make sense (e.g. "retail
// banking customer" with $80K in checking). The ranges are coarse — we only
// flag when the imbalance is dramatic, so the threshold tolerates legitimate
// variance.
const OCCUPATION_INCOME_BANDS = [
  { match: /retail\s+banking\s+customer|primary\s+banking\s+customer|consumer/i, monthlyMin: 2500, monthlyMax: 9000 },
  { match: /college\s+student|graduate\s+student|student/i,                       monthlyMin: 1200, monthlyMax: 3500 },
  { match: /gig\s+worker|rideshare|driver|freelance|contractor/i,                 monthlyMin: 1500, monthlyMax: 6500 },
  { match: /small\s+business|sole\s+proprietor|owner-operator/i,                  monthlyMin: 4000, monthlyMax: 18000 },
  { match: /senior\s+(engineer|developer)|tech\s+lead|principal/i,                monthlyMin: 9000, monthlyMax: 20000 },
  { match: /\bcfo\b|\bceo\b|\bcoo\b|\bcto\b|chief\s+\w+\s+officer/i,              monthlyMin: 14000, monthlyMax: 50000 },
  { match: /retiree|retired/i,                                                    monthlyMin: 1500, monthlyMax: 8000 },
];

// Generic placeholder patterns we should never see in customer-facing UI.
const GENERIC_DATA_PATTERNS = [
  { pattern: /\bjohn\s+doe\b/i,                          kind: 'persona-placeholder',  hint: 'John Doe — replace with a brand-appropriate persona name.' },
  { pattern: /\bjane\s+(?:doe|smith)\b/i,                kind: 'persona-placeholder',  hint: 'Jane Doe / Jane Smith — replace with a brand-appropriate persona name.' },
  { pattern: /\btest\s*user\b|\bdemo\s*user\b/i,         kind: 'persona-placeholder',  hint: '"test user" / "demo user" — use a realistic first + last name.' },
  { pattern: /\bexample@example\.\w+/i,                  kind: 'email-placeholder',    hint: 'example@example.com — use a plausible email format (firstname.lastname@<brand or gmail>.com).' },
  { pattern: /\bfoo|bar|baz\b/i,                         kind: 'generic-placeholder',  hint: 'foo/bar/baz placeholders — replace with realistic content.' },
  { pattern: /\blorem\s+ipsum\b/i,                       kind: 'lorem-ipsum',          hint: 'Lorem ipsum text — write realistic copy for the brand.' },
  { pattern: /\b555[-.\s]\d{4}\b/,                       kind: 'placeholder-phone',    hint: 'Movie-style 555 phone number — use a plausible area code.' },
  { pattern: /\b12345\s*(?:zip|postal)?\b/i,             kind: 'placeholder-zip',      hint: 'ZIP 12345 — use a realistic ZIP for the persona\'s claimed location.' },
];

// ─── Tiny helpers ───────────────────────────────────────────────────────────

function safe(s) { return s == null ? '' : String(s); }

function parseDollar(amountStr) {
  if (!amountStr) return null;
  const m = String(amountStr).match(/[-+]?\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function findDollarAmounts(text) {
  if (!text) return [];
  const re = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\b/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(`$${m[1]}`);
  return out;
}

function collectStepText(demoScript) {
  const steps = (demoScript && demoScript.steps) || [];
  return steps.map(s =>
    [s.label, s.visualState, s.uiDescription, s.narration].filter(Boolean).join(' ')
  ).join('\n');
}

// ─── Check: generic placeholder data (persona / email / lorem / 555 / 12345) ─

function checkGenericPlaceholders(demoScript) {
  const issues = [];
  const text = collectStepText(demoScript);
  const persona = (demoScript && demoScript.persona) || {};
  const personaText = [persona.name, persona.role, persona.company, persona.email].filter(Boolean).join(' ');
  const haystack = `${personaText}\n${text}`;
  for (const { pattern, kind, hint } of GENERIC_DATA_PATTERNS) {
    if (pattern.test(haystack)) {
      issues.push({
        kind,
        severity: 'critical',
        field: kind.startsWith('persona-') ? 'persona' : 'demoScript.steps[].visualState/narration',
        evidence: (haystack.match(pattern) || [])[0] || '',
        fix: hint,
      });
    }
  }
  return issues;
}

// ─── Check: "everything ends in .00" → fake-feeling round numbers ───────────

function checkRoundNumberRatio(demoScript) {
  const issues = [];
  const allText = collectStepText(demoScript);
  const amounts = findDollarAmounts(allText);
  if (amounts.length < 4) return issues; // too few to be meaningful
  // "Round" = no cents at all OR cents are exactly .00. Catches $2,000 / $500 /
  // $4,312.58 → only the last has non-trivial cents.
  const round = amounts.filter(a => {
    const n = parseDollar(a);
    if (n == null) return false;
    return Math.round((n - Math.floor(n)) * 100) === 0;
  }).length;
  const ratio = round / amounts.length;
  if (ratio > 0.6) {
    issues.push({
      kind: 'round-number-ratio',
      severity: 'warning',
      field: 'demoScript.steps[].visualState',
      evidence: `${round} of ${amounts.length} amounts are round (.00 or no cents) — ratio ${(ratio * 100).toFixed(0)}%`,
      fix: 'Real bank transactions rarely end in .00. Add cents to balances/transactions where realistic ($4,312.58 vs $4,300.00).',
    });
  }
  return issues;
}

// ─── Check: persona income vs claimed balances ──────────────────────────────

/**
 * Persona-income consistency. Flags when claimed balances are wildly out of
 * range for the persona's occupation/role. Only fires when both:
 *   - The persona has a `role` we can match a band for
 *   - The script mentions a balance ≥ a 24-month income upper bound
 */
function checkPersonaBalanceConsistency(demoScript) {
  const issues = [];
  const persona = (demoScript && demoScript.persona) || {};
  const role = safe(persona.role).trim();
  if (!role) return issues;
  const band = OCCUPATION_INCOME_BANDS.find(b => b.match.test(role));
  if (!band) return issues;

  const text = collectStepText(demoScript);
  const amounts = findDollarAmounts(text).map(parseDollar).filter(n => Number.isFinite(n));
  if (amounts.length === 0) return issues;
  const max = Math.max(...amounts);

  const upper = band.monthlyMax * 24; // 24 months of upper-bound income as a generous ceiling
  if (max > upper) {
    issues.push({
      kind: 'persona-balance-mismatch',
      severity: 'warning',
      field: 'demoScript.steps[].visualState',
      evidence: `Largest amount $${max.toLocaleString()} exceeds 24× monthly upper bound ($${upper.toLocaleString()}) for role "${role}".`,
      fix:
        `Either lower the on-screen balance/transaction amount to fit the persona's income, ` +
        `or change the persona's role to one consistent with this wealth level.`,
    });
  }
  return issues;
}

// ─── Check: account / card masking pattern ──────────────────────────────────

const COMMON_MASK_PATTERNS = [
  { name: 'bullet-4',     re: /(?:\u2022\u2022\u2022\u2022|\.{4}|\*{4})\d{4}/g, label: '••••XXXX or ....XXXX or ****XXXX' },
  { name: 'x-prefix-4',   re: /[xX]{4}\d{4}/g,                                  label: 'XXXXNNNN' },
  { name: 'dash-mask',    re: /[xX]{4}-\d{4}/g,                                 label: 'XXXX-NNNN' },
  { name: 'mid-dot-4',    re: /\u00b7{4}\d{4}/g,                                label: '····XXXX' },
];

/**
 * Verify that account/card masks in the demo conform to the brand's
 * convention (when one is present in the brand profile via `brand.masking`).
 * If no brand convention is declared we skip.
 */
function checkMaskingFormat(demoScript, brandProfile) {
  const issues = [];
  const expected = brandProfile && brandProfile.masking && brandProfile.masking.pattern;
  if (!expected) return issues;
  const expectedRe = COMMON_MASK_PATTERNS.find(p => p.name === expected) ||
    { re: new RegExp(expected) };
  const text = collectStepText(demoScript);
  // Find ANY mask-like substring in the text:
  let foundAnyMask = false;
  let foundMatching = false;
  for (const p of COMMON_MASK_PATTERNS) {
    if (p.re.test(text)) {
      foundAnyMask = true;
      if (p.name === expected) foundMatching = true;
    }
  }
  if (foundAnyMask && !foundMatching) {
    issues.push({
      kind: 'masking-format-mismatch',
      severity: 'warning',
      field: 'demoScript.steps[].visualState',
      evidence: `${brandProfile.name || 'brand'} convention is "${expectedRe.label || expected}" but the script uses a different masking style.`,
      fix: `Standardize all account/card masks to ${expectedRe.label || expected}.`,
    });
  }
  return issues;
}

// ─── Check: bank-feed transaction-description realism (heuristic) ───────────

/**
 * Real bank statement feeds have a distinctive shape: ALL CAPS merchant +
 * `DES:` / `CO ID:` / `INDN:` / `WEB ID:` markers / location fragments. LLMs
 * tend to write friendly title-cased descriptions ("Direct Deposit") that
 * match a marketing site, not a real statement.
 *
 * We flag when the script has ≥3 transactions but NONE of them include any
 * realistic-feed markers. Single-transaction edge cases are skipped.
 */
function checkTransactionFeedRealism(demoScript) {
  const issues = [];
  const text = collectStepText(demoScript);

  // Coarse "transaction-y" pattern: $amount near a description.
  const transactionLines = (text.match(/[A-Z][A-Z\s\d.&'-]{3,}\s+\$[\d,]+(?:\.\d{2})?/g) || []);
  if (transactionLines.length < 3) return issues;

  const realisticMarkers = /(DES:|CO\s?ID:|INDN:|WEB\s?ID:|PPD\s*ID:|ARC\s*ID:|POS\s+(?:DEBIT|PURCHASE)|ACH\s+(?:DEBIT|CREDIT|TRANSFER))/i;
  const matchCount = transactionLines.filter(line => realisticMarkers.test(line)).length;
  if (matchCount === 0) {
    issues.push({
      kind: 'transaction-feed-too-clean',
      severity: 'warning',
      field: 'demoScript.steps[].visualState',
      evidence:
        `${transactionLines.length} transaction-shaped strings detected but none use real-bank markers ` +
        `("DES:", "CO ID:", "POS DEBIT", "ACH CREDIT"). Real bank feeds aren't this tidy.`,
      fix:
        `Rewrite at least one transaction with a real-bank format, e.g. ` +
        `"BANK OF AMERICA DES:DIRECT DEP CO ID:9000123456 INDN:..." or ` +
        `"POS DEBIT 04/15 STARBUCKS #234 SAN FRANCISCO CA".`,
    });
  }
  return issues;
}

// ─── Top-level runner: deterministic checks ─────────────────────────────────

/**
 * Run all deterministic data-realism checks. Returns `{ issues, passed,
 * criticalCount, warningCount }` shape compatible with the agent-task md
 * builder + the orchestrator continue-gate logic.
 */
function runDeterministicChecks(demoScript, brandProfile = null) {
  const issues = [
    ...checkGenericPlaceholders(demoScript),
    ...checkRoundNumberRatio(demoScript),
    ...checkPersonaBalanceConsistency(demoScript),
    ...checkMaskingFormat(demoScript, brandProfile),
    ...checkTransactionFeedRealism(demoScript),
  ];
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  return {
    issues,
    criticalCount,
    warningCount,
    passed: criticalCount === 0,
  };
}

// ─── Optional LLM grader (Haiku) for transaction-feed realism ──────────────

/**
 * One Haiku call grades whether the script's transaction descriptions look
 * like a real $brand statement feed. Cheap (~300-500 tokens). Returns the
 * same `issues[]` shape as the deterministic checks. Caller decides whether
 * to invoke this — typically only when ANTHROPIC_API_KEY is set AND the
 * deterministic check didn't already flag something for the same reason.
 */
async function gradeWithHaiku(demoScript, brandProfile = null) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { issues: [], skipped: true, reason: 'no-anthropic-key' };
  }
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const model = 'claude-haiku-4-5-20251001';
  const brandName = (brandProfile && brandProfile.name) || (demoScript && demoScript.persona && demoScript.persona.company) || 'the host bank';
  const text = collectStepText(demoScript).slice(0, 4000);
  if (!text.trim()) return { issues: [], skipped: true, reason: 'no-text' };

  let raw = '';
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content:
          `You are reviewing the sample data in a demo script for "${brandName}". ` +
          `Identify generic / unrealistic on-screen content that a real ${brandName} customer would NEVER see. ` +
          `Focus on: persona name realism for ${brandName}'s segment; transaction descriptions resembling a real ` +
          `bank statement feed (ALL CAPS merchants, DES:/CO ID: markers, posted dates); on-screen amounts that ` +
          `look fake (round numbers, repeated digits, suspiciously even).\n\n` +
          `DEMO SCRIPT TEXT (concatenated step labels + visualState + narration):\n` +
          `\`\`\`\n${text}\n\`\`\`\n\n` +
          `Return JSON only. Schema:\n` +
          `{"issues": [{"kind": "<short-id>", "severity": "warning|critical", "field": "demoScript.steps[].visualState", "evidence": "<exact quoted snippet>", "fix": "<one-sentence fix>"}]}\n` +
          `If everything looks realistic, return {"issues": []}.`,
      }],
    });
    raw = (resp.content || []).map(b => b.text || '').join('').trim();
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const issues = Array.isArray(json.issues) ? json.issues
      .filter(i => i && i.kind && i.severity && i.evidence)
      .map(i => ({
        kind: `haiku:${i.kind}`,
        severity: i.severity === 'critical' ? 'critical' : 'warning',
        field: i.field || 'demoScript.steps[].visualState',
        evidence: i.evidence,
        fix: i.fix || '',
      })) : [];
    return { issues, model };
  } catch (err) {
    return { issues: [], skipped: true, reason: `haiku-error: ${err.message}`, raw };
  }
}

// ─── Agent-task md builder ─────────────────────────────────────────────────

function buildDataRealismFixTask({ runId, deterministic, llm, opts = {} }) {
  const allIssues = [...(deterministic.issues || []), ...((llm && llm.issues) || [])];
  const criticalCount = allIssues.filter(i => i.severity === 'critical').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const orchestratorDriven = !!opts.orchestratorDriven;
  const finalCmd = orchestratorDriven
    ? `npm run pipe -- continue ${runId}`
    : `npm run pipe -- stage script ${runId}`;
  const finalContext = orchestratorDriven
    ? `The orchestrator is **paused on a continue-gate** waiting for you. Run the command below to release ` +
      `it; the orchestrator will then proceed with the build using realistic sample data.`
    : `Re-generate the script (or hand-edit demo-script.json) so the issues below are addressed:`;

  let md =
    `# Data-realism issues — ${runId}\n\n` +
    `> **What this is:** an agent-ready prompt produced by the \`data-realism-check\` stage. ` +
    `Sample data in \`demo-script.json\` (persona, balances, transaction descriptions, masking) ` +
    `looks too clean / generic / inconsistent. Fix it before the build LLM bakes those values into ` +
    `the host app.\n\n` +
    `---\n\n` +
    `## SUMMARY\n\n` +
    `- **Run id:** \`${runId}\`\n` +
    `- **Issues:** ${allIssues.length} (${criticalCount} critical, ${warningCount} warning)\n` +
    (llm && llm.skipped ? `- **LLM grader:** skipped (${llm.reason})\n` : '') +
    (llm && llm.model ? `- **LLM grader:** \`${llm.model}\`\n` : '') +
    `\n---\n\n` +
    `## ISSUES\n\n`;

  if (allIssues.length === 0) {
    md += `_(no issues detected — this task should not have been written. Investigate and report.)_\n\n`;
  } else {
    allIssues.forEach((i, idx) => {
      md +=
        `### ${idx + 1}. \`${i.kind}\` — ${i.severity.toUpperCase()}\n\n` +
        `- **Field:** \`${i.field}\`\n` +
        `- **Evidence:** ${i.evidence}\n` +
        `- **Fix:** ${i.fix}\n\n`;
    });
  }

  md +=
    `---\n\n` +
    `## EDITING CONTRACT\n\n` +
    `- Edit \`demo-script.json\` directly. Use \`Read\` + \`StrReplace\` to make targeted changes.\n` +
    `- For persona issues: update \`persona.name\` / \`persona.role\` / \`persona.email\` to ` +
    `realistic values for the brand's segment.\n` +
    `- For transaction issues: rewrite the \`visualState\` text using real-bank-statement format ` +
    `(ALL CAPS merchants, DES: / CO ID: / POS DEBIT markers, plausible dates).\n` +
    `- For amount issues: add cents to balances and transactions ($4,312.58 not $4,300.00).\n` +
    `- Do NOT touch \`build-app.js\`, \`prompt-templates.js\`, or any pipeline plumbing.\n\n` +
    `---\n\n` +
    `## FINAL\n\n` +
    finalContext + `\n\n` +
    '```bash\n' + finalCmd + '\n' + '```\n\n' +
    `\n_Generated at ${new Date().toISOString()} by \`data-realism-check\`._\n`;

  return md;
}

module.exports = {
  // Public:
  runDeterministicChecks,
  gradeWithHaiku,
  buildDataRealismFixTask,
  // Exposed for tests + reuse:
  checkGenericPlaceholders,
  checkRoundNumberRatio,
  checkPersonaBalanceConsistency,
  checkMaskingFormat,
  checkTransactionFeedRealism,
  parseDollar,
  findDollarAmounts,
  OCCUPATION_INCOME_BANDS,
  GENERIC_DATA_PATTERNS,
};
