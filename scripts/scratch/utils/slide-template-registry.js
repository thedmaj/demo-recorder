'use strict';

/**
 * Load and validate the showcase slide-template registry (20 templates).
 * Registry JSON is generated from templates/slide-template/showcase/index.html
 * via generate-slide-template-registry.js.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_REL = path.join('templates', 'slide-template', 'slide-template-registry.json');
const SHOWCASE_INDEX_REL = path.join('templates', 'slide-template', 'showcase', 'index.html');

/** @type {Map<string, object>|null} */
let _cache = null;

const SIDEBAR_CATEGORY_TO_KEY = {
  Opening: 'opening',
  Explainer: 'explainer',
  'Metrics & Data': 'metrics',
  Comparison: 'comparison_flow',
  Flow: 'comparison_flow',
  'Comparison & Flow': 'comparison_flow',
  Plans: 'plans_proof',
  Proof: 'plans_proof',
  'Plans & Proof': 'plans_proof',
  Close: 'close',
};

const TAG_CATEGORY_TO_KEY = {
  Opening: 'opening',
  Explainer: 'explainer',
  Metrics: 'metrics',
  Comparison: 'comparison_flow',
  Flow: 'comparison_flow',
  Plans: 'plans_proof',
  Proof: 'plans_proof',
  Close: 'close',
};

const CATEGORY_DEFAULT_TEMPLATE = {
  opening: 't1-title-hero',
  explainer: 'bullet-list',
  metrics: 't4-triple-stat',
  comparison_flow: 't6-before-after',
  plans_proof: 'timeline',
  close: 't11-action-cards',
};

const CATEGORY_KEYWORDS = {
  opening: ['intro', 'overview', 'welcome', 'hero', 'opener', 'opening'],
  explainer: ['explain', 'why', 'how it works', 'capability', 'feature', 'bullet', 'pillar', 'statement'],
  metrics: ['percent', '%', 'kpi', 'metric', 'score', 'stat', 'number', 'rate', 'reduction', 'increase', 'table', 'chart', 'data'],
  comparison_flow: ['before', 'after', 'vs', 'versus', 'old way', 'new way', 'compare', 'flow', 'step', 'process', 'architecture', 'integration', 'pipeline'],
  plans_proof: ['timeline', 'roadmap', 'quote', 'testimonial', 'proof', 'code', 'api', 'snippet', 'customer'],
  close: ['summary', 'next step', 'cta', 'recap', 'value', 'outcome', 'action'],
};

// Controlled slideRole vocabulary, ~1:1 with templates. The script-generation
// LLM tags each slide step with one of these roles (its narrative job); the
// router maps role -> template with a strong score (see scoreTemplate). This is
// what lets the router disambiguate WITHIN a category (e.g. api-field-reveal vs
// kpi-dashboard, both "metrics") without a per-case hard-wire. A showcase
// <section> may override via data-step-roles="role[,role2]".
const TEMPLATE_STEP_ROLES = {
  't1-title-hero': ['opening'],
  't2-section-beat': ['section-break'],
  't3-statement-slide': ['problem-statement'],
  'bullet-list': ['concept-explainer'],
  't5-three-pillars': ['three-pillars'],
  'big-pull-quote': ['pull-quote'],
  't4-triple-stat': ['hero-metrics'],
  'kpi-grid': ['kpi-dashboard'],
  'api-field-table': ['api-field-reveal'],
  'data-table': ['data-comparison-table'],
  'bar-chart-insight': ['bar-chart'],
  't6-before-after': ['before-after'],
  't7-comparison-table': ['transformation-rows'],
  't8-step-flow': ['sequential-steps'],
  'flow-diagram': ['flow-diagram'],
  't9-architecture-map': ['architecture'],
  timeline: ['timeline'],
  roadmap: ['roadmap'],
  'code-window': ['code-proof'],
  't10-proof-quote': ['customer-proof'],
  't11-action-cards': ['value-summary'],
};

// Per-template DISCRIMINATING keywords. Unlike CATEGORY_KEYWORDS (identical
// across a whole category, so they can't separate same-category templates),
// these are the phrases unique to each template. Unioned with the category
// keywords at build time (additive recall + per-template discrimination). A
// showcase <section> may override via data-keywords="phrase; phrase".
const TEMPLATE_KEYWORDS = {
  // opening
  't1-title-hero': ['title', 'opener', 'hero moment', 'welcome', 'brand statement'],
  't2-section-beat': ['section', 'chapter', 'part one', 'where we are'],
  // explainer
  't3-statement-slide': ['single point', 'one idea', 'thesis', 'key takeaway'],
  'bullet-list': ['agenda', 'capabilities', 'rundown', 'list of', 'enumerated'],
  't5-three-pillars': ['three pillars', 'three capabilities', 'rule of three', 'three peers'],
  'big-pull-quote': ['pull quote', 'full-bleed quote', 'standout quote'],
  // metrics — the 4-way collision this whole change targets
  't4-triple-stat': ['three stats', 'three numbers', 'hero number', 'headline metric', 'side by side'],
  'kpi-grid': ['four metrics', 'dashboard', 'quarter over quarter', 'qoq', 'deltas', 'kpi grid', 'ops metrics', 'board update'],
  'api-field-table': ['fields returned', 'response fields', 'api fields', 'sample values', 'read-out', 'readout', 'field values', 'returns the following', 'income insights', 'cash flow insights', 'base report'],
  'data-table': ['pricing', 'tiers', 'plan comparison', 'thresholds', 'api limits', 'comparison rows'],
  'bar-chart-insight': ['bar chart', 'top n', 'top-n', 'categories', 'cohort', 'ranking'],
  // comparison_flow
  't6-before-after': ['before and after', 'old way', 'new way', 'manual vs', 'two panel', 'raw vs enriched'],
  't7-comparison-table': ['transformation', 'latency', 'accuracy', 'matched rows', 'cost comparison'],
  't8-step-flow': ['step 1', 'sequential', 'three steps', 'numbered', 'lifecycle', 'left to right'],
  'flow-diagram': ['pipeline', 'nodes', 'branches', 'flow diagram', 'data flow'],
  't9-architecture-map': ['platform', 'dependencies', 'big picture', 'system map', 'central block'],
  // plans_proof
  timeline: ['milestones', 'history', 'rollout phases', 'time axis'],
  roadmap: ['now next later', 'vision', 'planning', 'commitment levels'],
  'code-window': ['api call', 'snippet', 'endpoint', 'sdk', 'developer experience'],
  't10-proof-quote': ['testimonial', 'customer quote', 'proof point', 'why this is real'],
  // close
  't11-action-cards': ['next steps', 'call to action', 'get started', 'action cards', 'rollout phases'],
};

/**
 * Parse showcase index.html into registry template entries.
 * @param {string} html
 * @returns {object[]}
 */
function extractOpenTag(sectionHtml) {
  const start = sectionHtml.indexOf('<section');
  if (start < 0) return '';
  let inQuote = null;
  for (let i = start; i < sectionHtml.length; i++) {
    const ch = sectionHtml[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '>') return sectionHtml.slice(start, i + 1);
  }
  return '';
}

function parseShowcaseIndexHtml(html) {
  const sidebarCategories = parseSidebarCategories(html);
  const sections = [];
  const sectionRe = /<section\s+class="showcase-slide[\s\S]*?>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = sectionRe.exec(html)) !== null) {
    const openTag = extractOpenTag(m[0]);
    const id = extractAttr(openTag, 'id');
    const body = m[1];
    if (!id) continue;
    const name = extractAttr(openTag, 'data-name') || id;
    const whenToUse = extractAttr(openTag, 'data-when') || '';
    const avoidWhen = extractAttr(openTag, 'data-avoid') || '';
    const tagsRaw = extractAttr(openTag, 'data-tags') || '';
    const stepRolesRaw = extractAttr(openTag, 'data-step-roles') || '';
    const keywordsRaw = extractAttr(openTag, 'data-keywords') || '';
    const htmlRoles = stepRolesRaw ? stepRolesRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const htmlKeywords = keywordsRaw ? keywordsRaw.split(/[;,]/).map((s) => s.trim()).filter(Boolean) : null;
    const sr = body.match(/<div class="slide-root([^"]*)"([^>]*)>/i);
    let slideTemplate = 'T1';
    let workhorseLayout = '';
    let bgClass = '';
    if (sr) {
      const srAttrs = sr[0];
      slideTemplate = extractAttr(srAttrs, 'data-slide-template') || slideTemplate;
      workhorseLayout = extractAttr(srAttrs, 'data-workhorse-layout') || '';
      const classMatch = sr[0].match(/class="slide-root([^"]*)"/);
      if (classMatch) {
        const extras = classMatch[1].trim().split(/\s+/).filter((c) => c && c !== 'slide-root');
        bgClass = extras.find((c) => ['light', 'cream', 'holo'].includes(c)) || '';
      }
    }
    const tagLabels = [...tagsRaw.matchAll(/showcase-tag">([^<]+)</g)].map((x) => x[1].trim());
    const sidebarCategory = sidebarCategories.get(id) || inferCategoryFromTags(tagLabels);
    const category = TAG_CATEGORY_TO_KEY[sidebarCategory] || SIDEBAR_CATEGORY_TO_KEY[sidebarCategory] || 'explainer';
    sections.push({
      id,
      name,
      category,
      categories: sidebarCategory ? [sidebarCategory] : [],
      slideTemplate,
      workhorseLayout,
      backgroundClass: bgClass || null,
      whenToUse,
      avoidWhen,
      signals: buildSignals(id, category, whenToUse, name, workhorseLayout, { stepRoles: htmlRoles, keywords: htmlKeywords }),
    });
  }
  return sections;
}

function extractAttr(fragment, name) {
  const re = new RegExp(`(?:\\s|^)${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = fragment.match(re);
  if (m) return m[1];
  const reSingle = new RegExp(`(?:\\s|^)${name}\\s*=\\s*'([^']*)'`, 'i');
  const m2 = fragment.match(reSingle);
  return m2 ? m2[1] : '';
}

function parseSidebarCategories(html) {
  const map = new Map();
  const catRe = /<div class="showcase-cat">([^<]+)<\/div>\s*<ul>([\s\S]*?)<\/ul>/gi;
  let m;
  while ((m = catRe.exec(html)) !== null) {
    const label = m[1].replace(/&amp;/g, '&').trim();
    const ul = m[2];
    const liRe = /data-target="([^"]+)"/g;
    let li;
    while ((li = liRe.exec(ul)) !== null) {
      map.set(li[1], label);
    }
  }
  return map;
}

function inferCategoryFromTags(tagLabels) {
  for (const t of tagLabels) {
    if (TAG_CATEGORY_TO_KEY[t]) return t;
  }
  return 'Explainer';
}

function buildSignals(id, category, whenToUse, name, workhorseLayout, opts = {}) {
  const explicitRoles = Array.isArray(opts.stepRoles) && opts.stepRoles.length ? opts.stepRoles : null;
  const explicitKeywords = Array.isArray(opts.keywords) && opts.keywords.length ? opts.keywords : null;

  // Keywords: per-template discriminating phrases (HTML override > code map)
  // UNIONED with the category keywords (recall) and the whenToUse-derived
  // expansion (existing behavior). Per-template phrases are what break the
  // within-category tie; category keywords keep legacy recall for steps that
  // carry no slideRole.
  const perTemplate = explicitKeywords || TEMPLATE_KEYWORDS[id] || [];
  const catKeywords = CATEGORY_KEYWORDS[category] || [];
  const keywords = new Set([...perTemplate, ...catKeywords]);
  const text = `${whenToUse} ${name} ${workhorseLayout}`.toLowerCase();
  for (const [word] of text.matchAll(/\b[a-z]{4,}\b/g)) {
    if (catKeywords.some((k) => word.includes(k.replace(/\s+/g, '')))) {
      keywords.add(word);
    }
  }

  // Step roles: HTML override > code map > legacy close-only default.
  const stepRoles = explicitRoles
    || TEMPLATE_STEP_ROLES[id]
    || (category === 'close' ? ['value-summary'] : []);

  return {
    keywords: [...keywords].slice(0, 32),
    workhorseLayout,
    stepRoles,
  };
}

function getRegistryPath(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, REGISTRY_REL);
}

function getShowcaseIndexPath(projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, SHOWCASE_INDEX_REL);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {boolean} [opts.forceReload]
 */
function loadSlideTemplateRegistry(opts = {}) {
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  if (!opts.forceReload && _cache) return _cache;
  const registryPath = getRegistryPath(projectRoot);
  if (!fs.existsSync(registryPath)) {
    throw new Error(`slide-template-registry.json not found at ${registryPath} — run generate-slide-template-registry.js`);
  }
  const json = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const templates = Array.isArray(json.templates) ? json.templates : [];
  const byId = new Map();
  const byLayout = new Map();
  const byCategory = new Map();
  for (const t of templates) {
    byId.set(t.id, t);
    if (t.workhorseLayout) byLayout.set(t.workhorseLayout, t);
    const cat = t.category || 'explainer';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(t);
  }
  _cache = { meta: json.meta || {}, templates, byId, byLayout, byCategory, categoryDefaults: CATEGORY_DEFAULT_TEMPLATE };
  return _cache;
}

function getTemplateById(id, opts = {}) {
  const reg = loadSlideTemplateRegistry(opts);
  return reg.byId.get(String(id)) || null;
}

function getTemplateByWorkhorseLayout(layout, opts = {}) {
  const reg = loadSlideTemplateRegistry(opts);
  return reg.byLayout.get(String(layout)) || null;
}

function getTemplatesByCategory(category, opts = {}) {
  const reg = loadSlideTemplateRegistry(opts);
  return reg.byCategory.get(String(category)) || [];
}

function getCategoryDefaultTemplateId(category, opts = {}) {
  const reg = loadSlideTemplateRegistry(opts);
  const id = reg.categoryDefaults[category] || reg.categoryDefaults.explainer;
  return reg.byId.get(id) ? id : reg.templates[0]?.id;
}

function isKnownWorkhorseLayout(layout, opts = {}) {
  return !!getTemplateByWorkhorseLayout(layout, opts);
}

function isKnownShowcaseTemplateId(id, opts = {}) {
  return !!getTemplateById(id, opts);
}

module.exports = {
  PROJECT_ROOT,
  REGISTRY_REL,
  SHOWCASE_INDEX_REL,
  SIDEBAR_CATEGORY_TO_KEY,
  TAG_CATEGORY_TO_KEY,
  CATEGORY_DEFAULT_TEMPLATE,
  CATEGORY_KEYWORDS,
  TEMPLATE_STEP_ROLES,
  TEMPLATE_KEYWORDS,
  parseShowcaseIndexHtml,
  parseSidebarCategories,
  getRegistryPath,
  getShowcaseIndexPath,
  loadSlideTemplateRegistry,
  getTemplateById,
  getTemplateByWorkhorseLayout,
  getTemplatesByCategory,
  getCategoryDefaultTemplateId,
  isKnownWorkhorseLayout,
  isKnownShowcaseTemplateId,
  extractOpenTag,
};
