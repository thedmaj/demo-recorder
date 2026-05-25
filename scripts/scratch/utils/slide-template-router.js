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
  { pattern: /\/identity\//i, category: 'explainer', layouts: ['bullets', 'three-column'] },
];

const LAYOUT_KEYWORDS = {
  'stat-highlight': ['triple', 'three stat', 'hero number', 'side-by-side', 'peer benchmark', 'benchmark', 'two stat'],
  'kpi-grid': ['grid', 'four metric', 'dashboard', 'qoq', 'delta'],
  table: ['table', 'row', 'tier', 'pricing', 'threshold'],
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
  cta: ['next step', 'action', 'recap', 'close', 'value summary'],
  code: ['snippet', 'curl', 'json', 'endpoint', 'api call'],
  timeline: ['timeline', 'milestone', 'phase', 'quarter'],
  roadmap: ['roadmap', 'now next later', 'vision'],
  'customer-proof': ['customer', 'logo bar', 'proof'],
};

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

  if (ctx.hardTemplateId && template.id === ctx.hardTemplateId) score += 100;
  if (ctx.hardLayout && template.workhorseLayout === ctx.hardLayout) score += 100;
  if (ctx.hardSlideTemplate && template.slideTemplate === ctx.hardSlideTemplate) score += 50;

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

  const hardLayout = step?.workhorseLayout ? String(step.workhorseLayout).trim() : '';
  let hardTemplateId = '';
  if (hardLayout) {
    const byLayout = getTemplateByWorkhorseLayout(hardLayout, opts);
    if (byLayout) hardTemplateId = byLayout.id;
  }
  if (step?.showcaseTemplateId) hardTemplateId = String(step.showcaseTemplateId);

  const preferredCategory = step?.slideCategory
    ? String(step.slideCategory)
    : inferPreferredCategory({
        text,
        stepIndex,
        isValueSummary,
        endpointHint: epHint,
      });

  const ctx = {
    text,
    stepIndex,
    isValueSummary,
    isLastSlide,
    preferredCategory,
    endpointHint: epHint,
    recentLayouts,
    hardTemplateId,
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
};
