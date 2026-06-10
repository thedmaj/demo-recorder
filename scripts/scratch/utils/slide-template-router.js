'use strict';

/**
 * Deterministic showcase template router — picks one of 20 templates before post-slides LLM.
 */

const {
  CATEGORY_KEYWORDS,
  getCategoryDefaultTemplateId,
  getTemplateById,
  getTemplateByWorkhorseLayout,
  getTemplatesByCategory,
  loadSlideTemplateRegistry,
} = require('./slide-template-registry');

const ENDPOINT_CATEGORY_HINTS = [
  { pattern: /\/signal\/evaluate/i, category: 'metrics', layouts: ['stat-highlight', 'kpi-grid'] },
  { pattern: /\/investments\//i, category: 'metrics', layouts: ['kpi-grid', 'table'] },
  { pattern: /\/liabilities\//i, category: 'metrics', layouts: ['table', 'kpi-grid'] },
  { pattern: /\/link\/token\/create/i, category: 'comparison_flow', layouts: ['process-steps', 'flow-diagram'] },
  // Identity MATCH returns per-field similarity scores (legal_name / phone /
  // email / address) — a field→value reveal, NOT an explainer and NOT a
  // before/after. Must precede the generic /identity/ hint (first match wins).
  // The "form name vs bank name" phrasing in match copy used to trip the
  // comparison cue and route to t6/t3, producing a statement slide with
  // jammed label+value runs (KeyBank v2 identity-match-insight, 2026-06-10).
  { pattern: /\/identity\/match/i, category: 'metrics', layouts: ['field-table'] },
  { pattern: /\/identity\//i, category: 'explainer', layouts: ['bullets', 'three-column'] },
  // CRA / consumer report endpoints — webhook-driven lifecycles + score reveal slides.
  // LendScore is a single score → stat reveal. Base Report / Income Insights /
  // Cash Flow Insights return key field→value attribute data → a field table
  // reads far better than a big-number stat card (avoids the cover/T1 fallback
  // that produced jammed bare-span reveals).
  { pattern: /\/cra\/check_report\/lend_score/i, category: 'metrics', layouts: ['stat-highlight', 'kpi-grid'] },
  { pattern: /\/cra\/check_report\/(?:base_report|income_insights|cashflow_insights|partner_insights)/i, category: 'metrics', layouts: ['field-table'] },
  { pattern: /\/cra\/check_report\/network_insights/i, category: 'metrics', layouts: ['kpi-grid', 'stat-highlight'] },
  { pattern: /\/webhooks?\b/i, category: 'comparison_flow', layouts: ['process-steps', 'flow-diagram'] },
  // Plaid Protect / Trust Index — fraud risk explainer + score reveal.
  { pattern: /\/protect\//i, category: 'metrics', layouts: ['stat-highlight', 'kpi-grid'] },
  { pattern: /\/monitor\//i, category: 'explainer', layouts: ['bullets', 'three-column'] },
  // Transfer / ACATS / move endpoints — process/flow.
  { pattern: /\/transfer\//i, category: 'comparison_flow', layouts: ['process-steps', 'flow-diagram'] },
  { pattern: /\/investments\/auth/i, category: 'comparison_flow', layouts: ['process-steps', 'flow-diagram'] },
];

const LAYOUT_KEYWORDS = {
  'stat-highlight': ['triple', 'three stat', 'hero number', 'side-by-side', 'peer benchmark', 'benchmark', 'two stat'],
  'kpi-grid': ['grid', 'four metric', 'dashboard', 'qoq', 'delta'],
  table: ['table', 'row', 'tier', 'pricing', 'threshold'],
  // Per-field API reveals: N field names with sample values / similarity
  // scores. Previously absent — field-table could never win on text cues.
  'field-table': ['field score', 'match score', 'per-field', 'field-by-field', 'name score', 'fields an api returns', 'field table', 'legal_name', 'holder_category', 'sample values'],
  'chart-bar': ['chart', 'bar', 'top-n', 'cohort'],
  comparison: ['before', 'after', 'transformation', 'two-panel'],
  'process-steps': ['step 1', 'numbered', 'sequential', 'lifecycle'],
  'flow-diagram': ['diagram', 'node', 'arrow', 'pipeline'],
  'arch-diagram': ['architecture', 'platform', 'system', 'dependency'],
  bullets: ['bullet', 'list', 'capability', 'feature'],
  'three-column': ['three pillar', 'three value', 'parallel'],
  'big-quote': ['quote', 'testimonial', 'pull quote'],
  cover: ['hero', 'title', 'opener'],
  'section-divider': ['section', 'chapter', 'break'],
  // Expanded cta keywords — value-summary copy often re-phrases "value summary"
  // as "retro graduates", "production ready", "close · value" or similar.
  cta: ['next step', 'action', 'recap', 'close', 'value summary', 'retro graduates', 'production ready', 'close · value', 'production decisioning'],
  code: ['snippet', 'curl', 'json', 'endpoint', 'api call'],
  timeline: ['timeline', 'milestone', 'phase', 'quarter'],
  roadmap: ['roadmap', 'now next later', 'vision'],
  'customer-proof': ['customer', 'logo bar', 'proof'],
};

// Content-aware signal regexes — added May 2026 to fix routing misses observed
// across Tilt / Betterment / Zip slide-tier QA runs. Each detector returns a
// number > 0 when the signal is present; scoreTemplate multiplies that into a
// template-shape preference (see `applyContentSignals`).

/** Match meaningful numerics (percentages, durations, dollar amounts, multipliers). */
const NUMERIC_TOKEN_RE = /(?:\$\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:%|x|×|seconds?|secs?|ms|days?|bps|hrs?|hours?|weeks?))/gi;

/** Comparison/contrast cues — semantic, not just "before/after" tokens. */
const COMPARISON_CUES_RE = /\b(?:vs\.?|versus|instead of|compared to|rather than|over [a-z- ]+(?:bureau|baseline|status quo)|old way[^.]+new way|before[^.]{0,40}after)\b/i;

/** Lifecycle / process cues — arrows, ordinals, webhook lifecycles. */
const LIFECYCLE_CUES_RE = /(?:→|->|\bthen\b|\bnext\b|\bfirst[^.]+(?:second|then)\b|\bstep\s+\d|\brequested[^.]{0,60}(?:generating|ready)\b|\bwebhook[s]?\b|\b(?:requested|generating|ready)\s*(?:→|->|then|,)\s*(?:requested|generating|ready))/i;

/** Strip HTML so word counts reflect rendered copy, not markup volume. */
function _wordCount(text) {
  if (!text) return 0;
  return String(text)
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Score a template against the content-aware signals derived from the step's
 * narration + visualState. Pure additive — never subtracts (recent-layout dedup
 * already handles negative scoring in scoreTemplate).
 *
 * @param {object} template registry entry
 * @param {object} ctx scoring context
 * @returns {{ score: number, reasons: string[] }}
 */
function applyContentSignals(template, ctx) {
  const text = ctx.text;
  const layout = template.workhorseLayout;
  let score = 0;
  const reasons = [];

  // 1) Text density — biases toward layouts that fit the volume of copy.
  const wc = ctx.wordCount;
  if (wc > 0) {
    if (wc < 25) {
      if (['cover', 'big-quote', 'section-divider'].includes(layout)) {
        score += 4;
        reasons.push(`density-short:${wc}w`);
      }
    } else if (wc < 60) {
      if (['stat-highlight', 'big-quote'].includes(layout)) {
        score += 2;
        reasons.push(`density-medium:${wc}w`);
      }
    } else if (wc < 110) {
      if (['kpi-grid', 'bullets', 'three-column'].includes(layout)) {
        score += 2;
        reasons.push(`density-long:${wc}w`);
      }
    } else {
      if (['bullets', 'cta', 'three-column'].includes(layout)) {
        score += 3;
        reasons.push(`density-xlong:${wc}w`);
      }
    }
  }

  // 2) Numeric density — quantified narration belongs in stat/kpi layouts.
  const numCount = ctx.numericCount;
  if (numCount >= 3) {
    if (layout === 'kpi-grid') {
      score += 4;
      reasons.push(`numerics:${numCount}→kpi-grid`);
    } else if (layout === 'stat-highlight') {
      score += 2;
      reasons.push(`numerics:${numCount}→stat-highlight`);
    }
  } else if (numCount === 2) {
    if (layout === 'stat-highlight') {
      score += 3;
      reasons.push(`numerics:2→stat-highlight`);
    } else if (layout === 'kpi-grid') {
      score += 2;
      reasons.push(`numerics:2→kpi-grid`);
    }
  } else if (numCount === 1) {
    if (layout === 'stat-highlight') {
      score += 2;
      reasons.push(`numerics:1→stat-highlight`);
    }
  }

  // 3) Comparison / contrast cues. Suppressed when the endpoint hint already
  //    says this is a per-field API reveal: match copy like "form name vs bank
  //    name" reads as a comparison but the slide's job is the field→score
  //    table, not a before/after panel (Identity Match hijack, 2026-06-10).
  const endpointWantsFieldTable = !!ctx.endpointHint?.layouts?.includes('field-table');
  if (ctx.hasComparison && !endpointWantsFieldTable) {
    if (layout === 'comparison') {
      score += 4;
      reasons.push('comparison-cue');
    } else if (layout === 'stat-highlight') {
      score += 1;
      reasons.push('comparison-cue-secondary');
    }
  }

  // 4) Lifecycle / process cues — fixes the report-ready-slide case where
  //    the "requested → generating → ready" lifecycle should pick process-steps,
  //    not a 3-card stat grid.
  if (ctx.hasLifecycle) {
    if (layout === 'process-steps') {
      score += 5;
      reasons.push('lifecycle-cue');
    } else if (layout === 'flow-diagram') {
      score += 3;
      reasons.push('lifecycle-cue-flow');
    }
  }

  return { score, reasons };
}

function normalizeText(step) {
  return [
    step?.id,
    step?.label,
    step?.narration,
    step?.visualState,
    step?.apiResponse?.endpoint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function scoreTemplate(template, ctx) {
  const text = ctx.text;
  let score = 0;
  const reasons = [];

  if (template.category === ctx.preferredCategory) {
    score += 3;
    reasons.push(`category:${template.category}`);
  }

  for (const kw of template.signals?.keywords || []) {
    if (text.includes(String(kw).toLowerCase())) {
      score += 1.2;
      reasons.push(`kw:${kw}`);
    }
  }

  for (const [layout, kws] of Object.entries(LAYOUT_KEYWORDS)) {
    if (template.workhorseLayout !== layout) continue;
    for (const kw of kws) {
      if (text.includes(kw)) {
        score += 1.5;
        reasons.push(`layout-kw:${kw}`);
      }
    }
  }

  if (ctx.endpointHint?.layouts?.includes(template.workhorseLayout)) {
    score += 2.5;
    reasons.push('endpoint-layout');
  }

  if (ctx.stepIndex === 0 && template.category === 'opening') {
    score += 4;
    reasons.push('first-slide-opening');
  }

  if (ctx.isValueSummary && template.workhorseLayout === 'cta') {
    score += 6;
    reasons.push('value-summary-close');
  }

  if (ctx.isLastSlide && template.category === 'close') {
    score += 3;
    reasons.push('last-slide-close');
  }

  if (ctx.recentLayouts.includes(template.workhorseLayout)) {
    score -= 2;
    reasons.push('recent-dedup');
  }

  // Peer benchmark slides: two hero stats — prefer stat-highlight over dense tables (slide QA May 2026).
  if (/\bpeer[- ]benchmark\b/i.test(ctx.text)) {
    if (template.workhorseLayout === 'stat-highlight') {
      score += 4;
      reasons.push('peer-benchmark-stat-highlight');
    } else if (template.workhorseLayout === 'table') {
      score -= 4;
      reasons.push('peer-benchmark-avoid-table');
    }
  }

  // slideRole: the LLM-assigned narrative intent (e.g. api-field-reveal). The
  // dominant NON-hard signal (+12 > category +3 / keyword +1.2 / content +2-5),
  // so a matched role decisively resolves within-category ties — api-field-reveal
  // beats kpi-dashboard without a per-case hard-wire — yet still yields to the
  // author's explicit hard overrides (+50/+100 below).
  if (ctx.slideRole && Array.isArray(template.signals?.stepRoles)
      && template.signals.stepRoles.includes(ctx.slideRole)) {
    score += 12;
    reasons.push(`step-role:${ctx.slideRole}`);
  }

  if (ctx.hardTemplateId && template.id === ctx.hardTemplateId) score += 100;
  if (ctx.hardLayout && template.workhorseLayout === ctx.hardLayout) score += 100;
  if (ctx.hardSlideTemplate && template.slideTemplate === ctx.hardSlideTemplate) score += 50;

  // Content-aware signals (density, numerics, comparison, lifecycle). Pure
  // additive — never penalize; the rest of scoreTemplate already handles
  // negative scoring (recent-layout dedup, peer-benchmark avoid-table).
  const signals = applyContentSignals(template, ctx);
  score += signals.score;
  for (const r of signals.reasons) reasons.push(r);

  return { score, reasons };
}

function inferPreferredCategory(ctx) {
  const text = ctx.text;
  let best = { category: 'explainer', score: 0 };
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let s = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) s += 1;
    }
    if (ctx.isValueSummary && category === 'close') s += 5;
    if (ctx.stepIndex === 0 && category === 'opening') s += 4;
    if (s > best.score) best = { category, score: s };
  }
  if (ctx.endpointHint?.category) {
    return ctx.endpointHint.category;
  }
  return best.category;
}

function endpointHint(endpoint) {
  if (!endpoint) return null;
  for (const hint of ENDPOINT_CATEGORY_HINTS) {
    if (hint.pattern.test(endpoint)) return hint;
  }
  return null;
}

/**
 * @param {object} step Demo-script step
 * @param {object} [deckContext]
 * @param {number} [deckContext.stepIndex]
 * @param {number} [deckContext.totalSlides]
 * @param {string[]} [deckContext.recentLayouts] last 2 layouts used
 * @param {object} [opts]
 */
function routeSlideTemplate(step, deckContext = {}, opts = {}) {
  loadSlideTemplateRegistry(opts);
  const stepIndex = Number.isFinite(deckContext.stepIndex) ? deckContext.stepIndex : 0;
  const totalSlides = Number.isFinite(deckContext.totalSlides) ? deckContext.totalSlides : 1;
  const recentLayouts = Array.isArray(deckContext.recentLayouts) ? deckContext.recentLayouts : [];
  const text = normalizeText(step);
  const stepId = String(step?.id || '').toLowerCase();
  const isValueSummary = stepId === 'value-summary-slide' || /\bvalue summary\b/i.test(String(step?.label || ''));
  const isLastSlide = stepIndex === totalSlides - 1;
  const ep = step?.apiResponse?.endpoint || '';
  const epHint = endpointHint(ep);
  const slideRole = step?.slideRole ? String(step.slideRole).trim() : '';

  let hardLayout = step?.workhorseLayout ? String(step.workhorseLayout).trim() : '';
  let hardTemplateId = '';
  if (hardLayout) {
    const byLayout = getTemplateByWorkhorseLayout(hardLayout, opts);
    if (byLayout) hardTemplateId = byLayout.id;
  }
  if (step?.showcaseTemplateId) hardTemplateId = String(step.showcaseTemplateId);

  // CRA field-data reveals (Income Insights / Cash Flow Insights / Base Report)
  // must render as an api-field-table — never a KPI grid, which scores in the
  // same "metrics" category but jams label+value into bare adjacent spans
  // (observed live: kpi-grid produced "FREQUENCYBiweekly"). The endpoint hint
  // alone is only a weak +2.5 boost AND demo steps frequently omit
  // apiResponse.endpoint, so detect from the endpoint OR the step text and make
  // it a HARD layout so field-table decisively wins. lend_score is excluded
  // (single headline score → stat-highlight). Only force when the author has not
  // already pinned a layout/template of their own.
  //
  // GUARD (2026-06-10): this text heuristic must NOT hijack a slide whose intent
  // is clearly something else. The value-summary / close slide routinely RECAPS
  // CRA products in its narration ("…base report and income insights…"), which
  // wrongly forced a field-table onto a CTA close (observed: CashRepublic
  // value-summary-slide → api-field-table). Now that the script tags slideRole,
  // respect an explicit non-field role and never fire on the value-summary; a
  // genuine field reveal is either tagged api-field-reveal or carries a real CRA
  // endpoint (craEp), which still wins below.
  const roleAllowsCraText = !slideRole || slideRole === 'api-field-reveal';
  if (!hardLayout && !step?.showcaseTemplateId) {
    const craEp = /\/cra\/check_report\/(?:base_report|income_insights|cashflow_insights|partner_insights)/i.test(ep);
    const craText = !isValueSummary
      && roleAllowsCraText
      && !/lend[_\s-]?score/i.test(text)
      && /\b(income insights|cash[-\s]?flow insights|base report)\b/i.test(text);
    if (craEp || craText) {
      const ft = getTemplateByWorkhorseLayout('field-table', opts);
      if (ft) {
        hardLayout = 'field-table';
        hardTemplateId = ft.id;
      }
    }
  }

  const preferredCategory = step?.slideCategory
    ? String(step.slideCategory)
    : inferPreferredCategory({
        text,
        stepIndex,
        isValueSummary,
        endpointHint: epHint,
      });

  // Pre-compute content-aware features once per step so each scored template
  // can reuse them. Cheap regex / split passes (<1ms total per deck).
  const narrationText = String(step?.narration || '');
  const visualStateText = String(step?.visualState || '');
  const contentText = `${narrationText} ${visualStateText}`.trim();
  const wordCount = _wordCount(contentText);
  const numericCount = (contentText.match(NUMERIC_TOKEN_RE) || []).length;
  const hasComparison = COMPARISON_CUES_RE.test(contentText);
  const hasLifecycle = LIFECYCLE_CUES_RE.test(contentText);

  const ctx = {
    text,
    stepIndex,
    isValueSummary,
    isLastSlide,
    preferredCategory,
    endpointHint: epHint,
    slideRole,
    recentLayouts,
    hardTemplateId,
    // Content-aware signal features (consumed by applyContentSignals).
    wordCount,
    numericCount,
    hasComparison,
    hasLifecycle,
    hardLayout,
    hardSlideTemplate: step?.slideTemplate && /^T\d+$/i.test(String(step.slideTemplate))
      ? String(step.slideTemplate).trim().toUpperCase()
      : '',
  };

  const reg = loadSlideTemplateRegistry(opts);
  const scored = reg.templates.map((t) => {
    const { score, reasons } = scoreTemplate(t, ctx);
    return { template: t, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score);

  let winner = scored[0];
  if (!winner || winner.score < 1) {
    const fallbackId = getCategoryDefaultTemplateId(preferredCategory, opts);
    const fallback = getTemplateById(fallbackId, opts);
    winner = { template: fallback, score: 0.1, reasons: ['category-default'] };
  }

  const alternates = scored
    .filter((s) => s.template.id !== winner.template.id)
    .slice(0, 2)
    .map((s) => ({
      templateId: s.template.id,
      workhorseLayout: s.template.workhorseLayout,
      slideTemplate: s.template.slideTemplate,
      score: s.score,
    }));

  return {
    templateId: winner.template.id,
    showcaseTemplateId: winner.template.id,
    name: winner.template.name,
    slideTemplate: winner.template.slideTemplate,
    workhorseLayout: winner.template.workhorseLayout,
    category: winner.template.category,
    backgroundClass: winner.template.backgroundClass || null,
    score: Math.round(winner.score * 100) / 100,
    rationale: winner.reasons.slice(0, 6).join(', ') || 'category-default',
    whenToUse: winner.template.whenToUse,
    avoidWhen: winner.template.avoidWhen,
    alternates,
  };
}

module.exports = {
  routeSlideTemplate,
  normalizeText,
  inferPreferredCategory,
  endpointHint,
  scoreTemplate,
  applyContentSignals,
  NUMERIC_TOKEN_RE,
  COMPARISON_CUES_RE,
  LIFECYCLE_CUES_RE,
};
