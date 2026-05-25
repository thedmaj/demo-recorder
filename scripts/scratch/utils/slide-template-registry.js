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
      signals: buildSignals(category, whenToUse, name, workhorseLayout),
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

function buildSignals(category, whenToUse, name, workhorseLayout) {
  const keywords = new Set(CATEGORY_KEYWORDS[category] || []);
  const text = `${whenToUse} ${name} ${workhorseLayout}`.toLowerCase();
  for (const [word] of text.matchAll(/\b[a-z]{4,}\b/g)) {
    if (CATEGORY_KEYWORDS[category]?.some((k) => word.includes(k.replace(/\s+/g, '')))) {
      keywords.add(word);
    }
  }
  return {
    keywords: [...keywords].slice(0, 24),
    workhorseLayout,
    stepRoles: category === 'close' ? ['value-summary'] : [],
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
