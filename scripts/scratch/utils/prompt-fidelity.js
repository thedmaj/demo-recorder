'use strict';
/**
 * prompt-fidelity.js
 *
 * Pure helpers for the `prompt-fidelity-check` stage. The stage runs between
 * `script` and `script-critique`; its job is to catch story drift between
 * what the user wrote in `inputs/prompt.txt` and what the script LLM
 * produced in `demo-script.json` BEFORE the build LLM spends 32K tokens
 * generating a demo of the wrong thing.
 *
 * Three responsibilities:
 *
 *   1. `extractPromptEntities(promptText)` — deterministic regex extraction
 *      of the named entities the script must preserve (brand, persona,
 *      products, key dollar amounts, Plaid Link mode).
 *
 *   2. `detectStoryboardTier(promptText)` — classify the user's prompt into
 *      one of three tiers that drive how `buildScriptGenerationPrompt`
 *      shapes its arc:
 *        - `verbatim`         — explicit numbered beats / table / "Storyboard:"
 *                               heading. LLM maps 1:1.
 *        - `scenario-derived` — no beats but enough context (brand + ≥1 product
 *                               + a clear use-case sentence) to build a
 *                               custom storyboard tailored to THAT scenario,
 *                               using canonical arc as STRUCTURE only.
 *        - `generic`          — bare prompt; canonical arc with generic content
 *                               (today's behavior, the safety-net default).
 *
 *   3. `compareEntitiesToScript(entities, demoScript)` — diff the extracted
 *      entities against the produced `demo-script.json`. Returns
 *      `{ drifts: [...], score, criticalCount }`. Any critical drift +
 *      agent mode → orchestrator pauses on a continue-gate so the agent
 *      fixes the script BEFORE build runs.
 *
 *   4. `buildFidelityFixTask(...)` — agent-ready markdown handoff,
 *      mirroring the `qa-touchup` pattern.
 *
 * No I/O dependencies on stage orchestration — this file is pure functions
 * for testability.
 */

// ─── tiny helpers ───────────────────────────────────────────────────────────

function safeString(s) {
  return s == null ? '' : String(s);
}

function normalizeBrandName(s) {
  return safeString(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeProductName(s) {
  return safeString(s).trim().toLowerCase()
    .replace(/^plaid[\s-]+/, '')   // drop leading "Plaid"
    .replace(/[^a-z0-9]+/g, '-')   // tokenize separators
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

// ─── 1. Entity extraction ───────────────────────────────────────────────────

/**
 * Pull out the entities the user pinned in their prompt. This deliberately
 * uses the SAME patterns as `extractCompanyToken` / `extractApiTokens` in
 * `orchestrator.js` so naming stays consistent across the codebase.
 *
 * Returns an object with keys that are always present (empty arrays / null
 * when nothing matched), so downstream code never has to null-check.
 *
 * @param {string} promptText
 * @returns {{
 *   brand: string|null,
 *   brandDomain: string|null,
 *   persona: { name: string|null, role: string|null, raw: string|null },
 *   products: string[],          // normalized slugs ('auth', 'identity', ...)
 *   productLabels: string[],     // human-readable ('Auth', 'Identity', ...)
 *   amounts: string[],           // matched dollar amounts in original format
 *   plaidLinkMode: 'modal'|'embedded'|null,
 *   useCase: string|null,        // the user's one-sentence pitch, when present
 *   industry: string|null,       // explicitly declared industry/segment
 * }}
 */
function extractPromptEntities(promptText) {
  const text = safeString(promptText);
  const lower = text.toLowerCase();

  const out = {
    brand: null,
    brandDomain: null,
    persona: { name: null, role: null, raw: null },
    products: [],
    productLabels: [],
    amounts: [],
    plaidLinkMode: null,
    useCase: null,
    industry: null,
  };

  // ── brand ──
  // Priority order matters: in the story-first template **Host:** is the
  // canonical brand, while **Company / context:** is FREEFORM context (e.g.
  // "Dealer finance desk; 'Verify income…'") — not a brand name. Check the
  // authoritative brand fields (Host / Brand / Customer / Company) FIRST and
  // fall back to the freeform "Company / context" line only as a last resort,
  // so we don't mistake context prose for the brand.
  const brandLinePatterns = [
    /\*\*Host:\*\*\s*\**\s*([^—*\n]+)/i,
    /^Host:\s*([^—\n]+)/m,
    /\*\*Brand:\*\*\s*([^\n]+)/i,
    /\bBrand:\s*([^\n]+)/i,
    /\*\*Customer:\*\*\s*([^\n]+)/i,
    /\bCustomer:\s*([^\n]+)/i,
    /\*\*Company:\*\*\s*([^\n]+)/i,
    /\bCompany:\s*(?!\s*\/)([^\n]+)/i,
    /\*\*Company\s*\/\s*context:\*\*\s*([^\n]+)/i,
    /\bCompany\s*\/\s*context:\s*([^\n]+)/i,
  ];
  for (const re of brandLinePatterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) {
      out.brand = m[1].trim();
      break;
    }
  }

  // brand-domain via "Brand URL:" / "Canonical URL:" / "Brand domain:"
  const urlMatch = text.match(/\b(?:Brand\s+URL|Canonical\s+URL|Brand\s+domain)\s*:\s*(\S+)/i);
  if (urlMatch && urlMatch[1]) {
    try {
      const cleaned = urlMatch[1]
        .replace(/^https?:\/\//, '')
        .replace(/^www\./i, '')
        .replace(/\/.*$/, '');
      out.brandDomain = cleaned || null;
    } catch (_) {}
  }

  // brand fallback: domain root → "BankOfAmerica"
  if (!out.brand && out.brandDomain) {
    const root = out.brandDomain.split('.')[0];
    if (root) out.brand = root;
  }

  // ── persona ──
  // Patterns we actually see in template prompts:
  //   "Name / role: Michael Carter, retail banking customer"
  //   "Persona: Michael Carter, retail customer"
  //   "Persona name + role: Sarah, CFO"
  const personaPatterns = [
    /\*\*Name\s*\/\s*role:\*\*\s*([^\n]+)/i,
    /\bName\s*\/\s*role:\s*([^\n]+)/i,
    /\*\*Persona:\*\*\s*([^\n]+)/i,
    /\bPersona:\s*([^\n]+)/i,
    /\bPersona\s+name\s*\+?\s*role:\s*([^\n]+)/i,
  ];
  for (const re of personaPatterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) {
      const raw = m[1].trim();
      out.persona.raw = raw;
      // Split on first comma → name / role; otherwise the whole string is the name.
      const idx = raw.indexOf(',');
      if (idx > 0) {
        out.persona.name = raw.slice(0, idx).trim();
        out.persona.role = raw.slice(idx + 1).trim();
      } else {
        out.persona.name = raw;
      }
      break;
    }
  }

  // ── products (mirrors extractApiTokens but with normalized slugs too) ──
  // First check explicit declarations:
  const declared = [];
  const declRe = /(products?\s*(?:used)?|key\s+products?|apis?|products\s+featured)\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = declRe.exec(text))) {
    let tail = String(m[2] || '');
    // Skip lines that look like code/quoted strings (e.g. `Link products array:
    // ["transfer", "signal"]` and prose that follows). Backticks are the
    // signal that the line is documentation about API shape, not a
    // user-facing product list.
    if (tail.includes('`') || tail.includes('"') || tail.includes('[') || tail.includes(']')) continue;
    // Stop at the first sentence-ending punctuation — anything after a period
    // is prose, not part of the comma-separated product list.
    tail = tail.split(/[.](?=\s|$)/)[0];
    declared.push(
      ...tail
        .split(/[|,;/]/g)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  // Story-first template form: the products header sits on its own line and the
  // product list follows on the NEXT line(s), e.g.
  //   **Products featured (approved names only):**
  //   Plaid Link, **Plaid Bank Income**
  // The same-line declRe above can't see those, so read the block after a
  // "Products [featured]:" header up to the next blank line / heading / table.
  const allLines = text.split('\n');
  for (let i = 0; i < allLines.length; i++) {
    // Require PLURAL "products" (optionally "products featured/used", "key
    // products", "APIs") so we don't match singular headers like "Primary
    // product family:" and slurp the family value as a product.
    if (!/^[*_\s>#-]*(?:products(?:\s+featured|\s+used)?|key\s+products|apis)\b[^\n]*:\s*\**\s*$/i.test(allLines[i])) continue;
    for (let j = i + 1; j < allLines.length && j <= i + 4; j++) {
      const raw = allLines[j].trim();
      if (!raw) break;                                   // blank → end of block
      if (/^[-*]{2,}|^#{1,6}\s|^\||^\[\[/.test(raw)) break; // heading/table/sentinel
      if (/[`"[\]{}]/.test(raw)) break;                  // code / API-shape line
      if (/:\s*$/.test(raw)) break;                      // another header
      // Strip parenthetical qualifiers ("(foundation)", "(beta — hero)",
      // "(linked account context)", "(CRA / Check)") BEFORE splitting, so a
      // "/" inside a qualifier doesn't fragment the product name and the
      // qualifier text doesn't end up in the slug.
      const cleanedLine = raw.split(/[.](?=\s|$)/)[0].replace(/\([^)]*\)/g, ' ');
      declared.push(
        ...cleanedLine.split(/[|,;/]/g).map((s) => s.trim()).filter(Boolean)
      );
      // Most prompts put the whole list on one line; keep scanning a couple
      // more only if they look like continuation list items.
      if (!/^[-*]/.test(allLines[j + 1] ? allLines[j + 1].trim() : '')) break;
    }
  }

  const declaredText = declared.join(' ').toLowerCase();

  const productAdds = [];
  const addProduct = (label) => {
    const slug = normalizeProductName(label);
    // Reject obviously-invalid product slugs — anything containing instruction
    // verbs ("do not add"), comparative phrases ("coverage is"), or anything
    // longer than 40 chars (real Plaid product names cap around 24 chars,
    // e.g. "Identity Verification (IDV)"). This catches PK / documentation
    // snippets that escaped the declared-list regex.
    if (!slug) return;
    if (slug.length > 40) return;
    if (/^(?:do-not|adding-it|coverage-is|implicit-in|narrows|please|note|see-also|requires)/.test(slug)) return;
    if (productAdds.find(p => p.slug === slug)) return;
    productAdds.push({ slug, label });
  };

  // Declared list takes priority — preserve as-typed where possible.
  // Strip stray markdown emphasis (**Auth**), trailing punctuation, and
  // leading "Plaid " when present.
  for (const item of declared) {
    if (!item) continue;
    const cleaned = item
      .replace(/^[*_`\s]+|[*_`\s.,;:!?]+$/g, '')
      .replace(/^plaid\s+/i, '')
      .trim();
    if (cleaned) addProduct(cleaned);
  }

  // Keyword fallback (only adds if we don't already have it).
  // Negation-aware: prompts routinely EXCLUDE products in prose ("do not
  // bundle `auth`, `identity`, or `signal`", "NOT Plaid Check / CRA",
  // "Layer / OAuth / IDV — not in scope"). A naive whole-text scan treats
  // those exclusions as EXPECTED products and emits false "product-missing"
  // criticals downstream. Only count a keyword as affirmative when at least
  // one line that mentions it is NOT a negation/exclusion line.
  const NEG_RE = /\bnot\b|\bnever\b|n['’]t\b|\bwithout\b|\bexclud\w*|\bnor\b|\binstead\b|\brather than\b|\bout of scope\b|\bnot in scope\b|❌/i;
  // Operate on whitespace-collapsed text so a negation that wraps onto a
  // separate physical line ("…do not bundle `auth`,\n`identity`, or `signal`")
  // still sits in the same window as the keyword. For each match, inspect a
  // window ~55 chars before + ~28 after (covers leading "do not bundle …" and
  // trailing "… — not in scope"). Affirmative iff at least one match has a
  // clean (non-negated) window.
  const collapsed = lower.replace(/\s+/g, ' ');
  const mentionedAffirmatively = (re) => {
    const gre = new RegExp(re.source, 'gi');
    let mm;
    while ((mm = gre.exec(collapsed))) {
      const s = Math.max(0, mm.index - 55);
      const e = Math.min(collapsed.length, mm.index + mm[0].length + 28);
      if (!NEG_RE.test(collapsed.slice(s, e))) return true;
      if (gre.lastIndex === mm.index) gre.lastIndex++; // guard zero-width
    }
    return false; // all mentions negated, or none found → don't add
  };
  if (mentionedAffirmatively(/\bauth\b|\binstant auth\b/i)) addProduct('Auth');
  if (mentionedAffirmatively(/\bidentity\s*(?:match|verification)?\b|\bidv\b/i)) addProduct('Identity Match');
  // "signal" is also common English ("cash-flow signal", "strong signal") —
  // require the product form ("Plaid Signal") in prose, or a declared mention.
  if ((mentionedAffirmatively(/\bplaid\s+signal\b/i) || /\bsignal\b/.test(declaredText))) addProduct('Signal');
  if (mentionedAffirmatively(/\bcra\b|\bbase report\b|\bconsumer report\b/i)) addProduct('CRA Base Report');
  if (mentionedAffirmatively(/\bbank income\b/i)) addProduct('Bank Income');
  if (mentionedAffirmatively(/\bincome\s+insights\b/i)) addProduct('Income Insights');
  // "Statements" is common English ("bank statements") — declared-list only,
  // same rationale as Layer / Transfer below.
  if (/\bstatements\b/.test(declaredText)) addProduct('Statements');
  // Two products are added ONLY from the declared list — both have words that
  // are common English (Layer = stack of approvals, Transfer = the verb), so
  // a free-text keyword scan would produce false positives that get flagged
  // as critical "product-missing" drifts downstream.
  if (/\blayer\b/.test(declaredText)) addProduct('Layer');
  if (/\btransfer\b/.test(declaredText) || /\bplaid\s+transfer\b/i.test(text)) addProduct('Transfer');

  out.products = dedupe(productAdds.map(p => p.slug));
  out.productLabels = productAdds.map(p => p.label);

  // ── dollar amounts (only the ones the user pinned in the prompt) ──
  // Match $1,234.56 / $1,234 / $0.99 / $500 — but only when in narrative text,
  // not in code blocks or URLs.
  const amountRe = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\b/g;
  const amounts = [];
  let am;
  while ((am = amountRe.exec(text))) {
    amounts.push(`$${am[1]}`);
  }
  out.amounts = dedupe(amounts).slice(0, 12); // cap to avoid noise

  // ── Plaid Link mode ──
  const linkModePatterns = [
    /\*\*Plaid\s+Link\s+mode:\*\*\s*([^\n]+)/i,
    /\bPlaid\s+Link\s+mode\s*:\s*([^\n]+)/i,
  ];
  for (const re of linkModePatterns) {
    const mm = text.match(re);
    if (mm && /\bembedded\b/i.test(mm[1])) { out.plaidLinkMode = 'embedded'; break; }
    if (mm && /\bmodal\b/i.test(mm[1])) { out.plaidLinkMode = 'modal'; break; }
  }
  if (!out.plaidLinkMode) {
    if (/\bembedded\s+link\b|\bplaid\s+link\s+embed(?:ded)?\b|\bembedded\s+institution\s+search\b/i.test(text)) {
      out.plaidLinkMode = 'embedded';
    } else if (/\bmodal\s+link\b|\bplaid\s+link\s+modal\b/i.test(text)) {
      out.plaidLinkMode = 'modal';
    }
  }

  // ── industry (when explicitly stated) ──
  const industryPatterns = [
    /\*\*Industry:\*\*\s*([^\n]+)/i,
    /\bIndustry\s*\/?\s*segment\s*:\s*([^\n]+)/i,
    /\bIndustry:\s*([^\n]+)/i,
  ];
  for (const re of industryPatterns) {
    const mm = text.match(re);
    if (mm && mm[1] && mm[1].trim()) { out.industry = mm[1].trim(); break; }
  }

  // ── use case (the user's one-sentence pitch) ──
  // Patterns from quickstart wizard + prompt template:
  //   "Use case (user pitch): ..."
  //   "Use case: ..."
  //   "**User journey (one sentence):** ..."
  //   "Story arc (short prose): ..."
  const useCasePatterns = [
    /\*\*Use\s+case[^:]*:\*\*\s*([^\n]+)/i,
    /\bUse\s+case[^:\n]{0,40}:\s*([^\n]+)/i,
    /\*\*User\s+journey[^:]*:\*\*\s*([^\n]+)/i,
    /\bUser\s+journey[^:\n]{0,40}:\s*([^\n]+)/i,
    /\*\*Story\s+arc[^:]*:\*\*\s*([^\n]+)/i,
    /\bStory\s+arc[^:\n]{0,40}:\s*([^\n]+)/i,
  ];
  for (const re of useCasePatterns) {
    const mm = text.match(re);
    if (mm && mm[1] && mm[1].trim().length > 10) {
      out.useCase = mm[1].trim();
      break;
    }
  }

  return out;
}

// ─── 2. Storyboard tier detection ────────────────────────────────────────────

/**
 * Classify the user's prompt into one of three tiers driving how the script
 * LLM shapes the demo arc.
 *
 * Tier 1 `verbatim` — user wrote explicit beats:
 *   - markdown table with header containing "beat|step|screen"
 *   - "Storyboard:" / "Story arc (short prose):" / "Beats:" heading followed
 *     by a numbered list ≥3 items
 *   - generic numbered list ≥3 in body (last-resort signal; only counts when
 *     paired with one of the storyboard headings)
 *
 * Tier 2 `scenario-derived` — no explicit beats but enough context for the
 *   LLM to build a tailored storyboard:
 *   - brand AND ≥1 product AND (useCase OR a scenario sentence ≥30 words)
 *
 * Tier 3 `generic` — fallback when neither tier 1 nor tier 2 applies.
 *   Today's canonical arc behavior.
 *
 * Returns `{ tier, signals: [...], beatList: [...], rawHeading: string|null }`.
 * `beatList` is populated for tier 1 so the script LLM can map 1:1.
 */
function detectStoryboardTier(promptText, opts = {}) {
  const text = safeString(promptText);
  const signals = [];
  let beatList = [];
  let rawHeading = null;

  // ── tier 1 signals ──
  // a) Explicit storyboard heading:
  const headingMatch = text.match(
    /^[ \t]*(?:#{1,4}\s*)?\**\s*(Storyboard|Story\s+arc|Beats|Demo\s+steps|Demo\s+flow)\b[^\n]*$/im
  );
  if (headingMatch) {
    signals.push('explicit_storyboard_heading');
    rawHeading = headingMatch[0].trim();
  }

  // b) Numbered list (≥3 items) anywhere in body:
  const numberedItems = (text.match(/^\s*\d+[.)]\s+\S/gm) || []);
  if (numberedItems.length >= 3) {
    signals.push(`numbered_list_${numberedItems.length}_items`);
    // Pull the actual lines so we can hand them to the LLM verbatim.
    for (const line of text.split('\n')) {
      const stripped = line.replace(/^\s*\d+[.)]\s+/, '').trim();
      if (stripped && /^\s*\d+[.)]\s+/.test(line)) {
        beatList.push(stripped);
      }
    }
    // Cap at a sane number — pipe template's storyboard table is typically ≤14:
    if (beatList.length > 20) beatList = beatList.slice(0, 20);
  }

  // c) Markdown table with a beat-like header column:
  const tableHeader = text.match(
    /\|\s*#\s*\|.*?\b(Beat\s*Type|Beat|Step|Screen|Scene)\b.*?\|/i
  );
  if (tableHeader) {
    signals.push('storyboard_table');
  }

  // Promote to verbatim when EITHER (a)+(b) OR (c) fires.
  // The plain numbered list alone is ambiguous (could be a setup checklist or
  // a Q&A list) — we require it to co-occur with a storyboard heading.
  const isVerbatim =
    (signals.includes('explicit_storyboard_heading') && numberedItems.length >= 3) ||
    signals.includes('storyboard_table');

  if (isVerbatim) {
    return { tier: 'verbatim', signals, beatList, rawHeading };
  }

  // ── tier 2 signals (scenario-derived) ──
  const entities = opts.entities || extractPromptEntities(text);
  const hasBrand = !!entities.brand;
  const hasProducts = entities.products.length > 0;
  const hasUseCase = !!entities.useCase && entities.useCase.length >= 30;

  // Fallback "scenario sentence" detector: any single sentence ≥30 words
  // that mentions the brand AND a Plaid product. This catches free-prose
  // pitches like "BofA wants to verify external account ownership before
  // allowing high-value ACH transfers, without micro-deposits."
  let scenarioSentence = null;
  if (hasBrand && hasProducts && !hasUseCase) {
    const brandLower = entities.brand.toLowerCase();
    const productPatterns = entities.products.map(p =>
      new RegExp('\\b' + p.replace(/-/g, '\\W*') + '\\b', 'i')
    );
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const sLower = s.toLowerCase();
      const wordCount = s.split(/\s+/).length;
      if (wordCount >= 30 && sLower.includes(brandLower)) {
        if (productPatterns.some(re => re.test(s))) {
          scenarioSentence = s;
          break;
        }
      }
    }
  }

  if (hasBrand && hasProducts && (hasUseCase || scenarioSentence)) {
    signals.push('scenario_context_present');
    if (hasUseCase) signals.push('use_case_line');
    if (scenarioSentence) signals.push('scenario_sentence');
    return {
      tier: 'scenario-derived',
      signals,
      beatList: [],
      rawHeading: null,
      scenarioContext: {
        useCase: entities.useCase,
        scenarioSentence,
      },
    };
  }

  // ── tier 3 fallback ──
  signals.push('no_storyboard_no_scenario_context');
  return { tier: 'generic', signals, beatList: [], rawHeading: null };
}

// ─── 3. Compare entities → demoScript ───────────────────────────────────────

const SEVERITY = { critical: 'critical', warning: 'warning', info: 'info' };

/**
 * Diff what the user said vs what the script produced. Drift severity:
 *   - brand mismatch              → critical
 *   - persona name mismatch       → critical
 *   - product missing             → critical
 *   - product extra (not in prompt) → warning
 *   - amount in prompt missing from any visualState → warning
 *   - plaidLinkMode mismatch      → critical
 *
 * Returns `{ drifts: [{field, expected, actual, severity, kind, fix}], ... }`.
 */
function compareEntitiesToScript(entities, demoScript) {
  const drifts = [];
  const script = demoScript || {};
  const persona = script.persona || {};
  const stepBlobs = (script.steps || []).map(s =>
    [s.label, s.visualState, s.narration].filter(Boolean).join(' ')
  ).join('\n');

  // ── brand ──
  if (entities.brand) {
    const expected = normalizeBrandName(entities.brand);
    const actualCompany = persona.company || persona.organization || persona.brand || null;
    const actualNorm = normalizeBrandName(actualCompany || '');
    if (!actualCompany) {
      drifts.push({
        field: 'persona.company',
        kind: 'brand-missing',
        expected: entities.brand,
        actual: null,
        severity: SEVERITY.critical,
        fix: `Set demoScript.persona.company to "${entities.brand}".`,
      });
    } else if (actualNorm !== expected && !actualNorm.includes(expected) && !expected.includes(actualNorm)) {
      drifts.push({
        field: 'persona.company',
        kind: 'brand-mismatch',
        expected: entities.brand,
        actual: actualCompany,
        severity: SEVERITY.critical,
        fix: `Rename demoScript.persona.company from "${actualCompany}" to "${entities.brand}".`,
      });
    }
  }

  // ── persona ──
  if (entities.persona && entities.persona.name) {
    const exp = entities.persona.name.toLowerCase();
    const actName = persona.name || '';
    if (!actName) {
      drifts.push({
        field: 'persona.name',
        kind: 'persona-missing',
        expected: entities.persona.name,
        actual: null,
        severity: SEVERITY.critical,
        fix: `Set demoScript.persona.name to "${entities.persona.name}".`,
      });
    } else if (!actName.toLowerCase().includes(exp.split(/\s+/)[0])) {
      // Compare first names — full-name drift is OK if the first name matches.
      drifts.push({
        field: 'persona.name',
        kind: 'persona-mismatch',
        expected: entities.persona.name,
        actual: actName,
        severity: SEVERITY.critical,
        fix: `Rename demoScript.persona.name from "${actName}" to "${entities.persona.name}".`,
      });
    }
  }

  // ── products ──
  // Look for product mentions in step labels / visualStates / narration.
  // Note: app-only host policy forbids product names IN visualState, but
  // narration is exempt. We're checking that the products are at least
  // referenced in narration (or in step ids / labels).
  for (const slug of entities.products) {
    const re = new RegExp('\\b' + slug.replace(/-/g, '[\\s-]?') + '\\b', 'i');
    if (!re.test(stepBlobs)) {
      drifts.push({
        field: 'products',
        kind: 'product-missing',
        expected: slug,
        actual: null,
        severity: SEVERITY.critical,
        fix: `Demo script never references "${slug}" — confirm it should be featured (the prompt listed it). ` +
          `Add a step or narration line that exercises this product, or remove it from the prompt's products list.`,
      });
    }
  }

  // ── plaidLinkMode ──
  if (entities.plaidLinkMode) {
    const actual = (script.plaidLinkMode || '').toLowerCase();
    if (actual && actual !== entities.plaidLinkMode) {
      drifts.push({
        field: 'plaidLinkMode',
        kind: 'plaid-link-mode-mismatch',
        expected: entities.plaidLinkMode,
        actual,
        severity: SEVERITY.critical,
        fix: `Set demoScript.plaidLinkMode to "${entities.plaidLinkMode}" (prompt explicitly requested it).`,
      });
    }
  }

  // ── amounts ──
  // For each amount the user pinned, confirm it appears in at least one step.
  // Loose match: strip non-digit/period chars before comparing.
  const stepDigits = stepBlobs.replace(/[^0-9.]/g, '');
  for (const amt of entities.amounts) {
    const digits = amt.replace(/[^0-9.]/g, '');
    if (!digits) continue;
    if (!stepDigits.includes(digits)) {
      drifts.push({
        field: 'amounts',
        kind: 'amount-missing',
        expected: amt,
        actual: null,
        severity: SEVERITY.warning,
        fix: `Amount ${amt} appears in the user's prompt but no step's visualState/narration references it.`,
      });
    }
  }

  const criticalCount = drifts.filter(d => d.severity === SEVERITY.critical).length;
  const warningCount = drifts.filter(d => d.severity === SEVERITY.warning).length;
  const score = drifts.length === 0 ? 100 :
    Math.max(0, 100 - (criticalCount * 20) - (warningCount * 5));

  return {
    drifts,
    criticalCount,
    warningCount,
    score,
    passed: criticalCount === 0,
  };
}

// ─── 4. Agent-task md builder (mirrors qa-touchup pattern) ──────────────────

function buildFidelityFixTask({ runId, entities, comparison, storyboardTier, opts = {} }) {
  const o = opts || {};
  const orchestratorDriven = !!o.orchestratorDriven;
  const final = orchestratorDriven
    ? `npm run pipe -- continue ${runId}`
    : `npm run pipe -- stage script ${runId}`;
  const finalContext = orchestratorDriven
    ? `The orchestrator is **paused on a continue-gate** waiting for you. ` +
      `Run the command below to release it; the orchestrator will then re-run script-critique ` +
      `and proceed to build with a script that matches the user's brief.`
    : `Run a re-script so the corrections take effect:`;

  let md =
    `# Prompt-fidelity drift detected — ${runId}\n\n` +
    `> **What this is:** an agent-ready prompt produced by the \`prompt-fidelity-check\` stage. ` +
    `The user's \`inputs/prompt.txt\` and the LLM-generated \`demo-script.json\` disagree on ` +
    `named entities (brand, persona, products, amounts, or Plaid Link mode). Fix the script ` +
    `(or, if the user's prompt has the typo, the prompt) before the build LLM commits to a ` +
    `wrong demo.\n\n` +
    `> **Story tier:** \`${storyboardTier.tier}\` (${storyboardTier.signals.join(', ') || 'no signals'})\n\n` +
    `---\n\n` +
    `## DRIFT SUMMARY\n\n` +
    `- **Run id:** \`${runId}\`\n` +
    `- **Fidelity score:** ${comparison.score}/100  ` +
    `(${comparison.criticalCount} critical, ${comparison.warningCount} warning)\n` +
    `- **Files involved:** \`inputs/prompt.txt\` (source of truth) and \`demo-script.json\` (script LLM output).\n\n` +
    `---\n\n` +
    `## EXTRACTED ENTITIES (from \`prompt.txt\`)\n\n` +
    '```json\n' + JSON.stringify(entities, null, 2) + '\n```\n\n' +
    `---\n\n` +
    `## DRIFTS (fix each before continuing)\n\n`;

  if (comparison.drifts.length === 0) {
    md += `_(no drifts detected — this task should not have been written. Investigate and report.)_\n\n`;
  } else {
    comparison.drifts.forEach((d, i) => {
      md +=
        `### ${i + 1}. \`${d.kind}\` — ${d.severity.toUpperCase()}\n\n` +
        `- **Field:** \`${d.field}\`\n` +
        `- **Expected (from prompt):** ${d.expected != null ? '`' + JSON.stringify(d.expected) + '`' : '_(absent)_'}\n` +
        `- **Actual (in demoScript):** ${d.actual != null ? '`' + JSON.stringify(d.actual) + '`' : '_(absent)_'}\n` +
        `- **Fix:** ${d.fix}\n\n`;
    });
  }

  md +=
    `---\n\n` +
    `## EDITING CONTRACT\n\n` +
    `- Edit \`demo-script.json\` directly when the prompt is correct and the script drifted. ` +
    `Use \`Read\` + \`StrReplace\` (or rewrite via the \`Edit\` tool) — preserve the schema, ` +
    `including step ids and ordering.\n` +
    `- Edit \`inputs/prompt.txt\` only when the user's prompt has a clear typo or contradiction. ` +
    `Document the change in your handoff message so the user can review.\n` +
    `- Do NOT touch \`build-app.js\`, \`prompt-templates.js\`, or any pipeline plumbing.\n\n` +
    `---\n\n` +
    `## VERIFICATION CHECKLIST\n\n` +
    `- [ ] Every critical drift listed above has been fixed (or an explicit override note added).\n` +
    `- [ ] \`demo-script.json\` is still valid JSON (re-validate by running it through \`JSON.parse\`).\n` +
    `- [ ] If \`storyboardTier === 'verbatim'\`, the demo script's step count matches the user's beat count.\n` +
    `- [ ] If \`storyboardTier === 'scenario-derived'\`, every product the user listed is exercised in at least one step.\n\n` +
    `---\n\n` +
    `## FINAL — hand back\n\n` +
    finalContext + `\n\n` +
    '```bash\n' + final + `\n` + '```\n\n' +
    `Then summarize the changes (1-2 sentences) so the user knows what was adjusted.\n` +
    `\n_Generated at ${new Date().toISOString()} by \`prompt-fidelity-check\`._\n`;

  return md;
}

module.exports = {
  // Public API:
  extractPromptEntities,
  detectStoryboardTier,
  compareEntitiesToScript,
  buildFidelityFixTask,
  // Internal helpers exposed for tests:
  normalizeBrandName,
  normalizeProductName,
};
