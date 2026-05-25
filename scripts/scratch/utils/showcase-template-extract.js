'use strict';

/**
 * Extract per-template .slide-root HTML skeletons from showcase/index.html for LLM prompts.
 */

const fs = require('fs');
const { stripChromeFootFromHtml } = require('./slide-chrome-foot');
const {
  getShowcaseIndexPath,
  getTemplateById,
  loadSlideTemplateRegistry,
  PROJECT_ROOT,
} = require('./slide-template-registry');

/** @type {Map<string, string>|null} */
let _skeletonCache = null;

function loadShowcaseHtml(projectRoot = PROJECT_ROOT) {
  const p = getShowcaseIndexPath(projectRoot);
  return fs.readFileSync(p, 'utf8');
}

/**
 * Extract outer HTML of .slide-root for a showcase section id.
 * @param {string} html Full showcase index.html
 * @param {string} templateId Section id (e.g. kpi-grid)
 * @returns {string|null}
 */
function extractSlideRootFromSection(html, templateId) {
  const id = String(templateId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const sectionRe = new RegExp(
    `<section\\s+class="showcase-slide[\\s\\S]*?id="${id}"[\\s\\S]*?>([\\s\\S]*?)<\\/section>`,
    'i'
  );
  const m = html.match(sectionRe);
  if (!m) return null;
  const body = m[1];
  const start = body.search(/<div class="slide-root/);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < body.length) {
    const open = body.slice(i).match(/^<div[\s>]/);
    const close = body.slice(i).match(/^<\/div>/);
    if (open) {
      depth += 1;
      i += open[0].length;
      continue;
    }
    if (close) {
      depth -= 1;
      i += close[0].length;
      if (depth === 0) return body.slice(start, i);
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Replace visible text nodes with placeholder tokens (structure preserved).
 * @param {string} html
 */
function tokenizeSkeletonCopy(html) {
  let out = stripChromeFootFromHtml(html);
  out = out.replace(/(<h2[^>]*class="[^"]*h-title[^"]*"[^>]*>)([\s\S]*?)(<\/h2>)/gi, '$1{HEADLINE}$3');
  out = out.replace(/(<p[^>]*class="[^"]*slide-body-text[^"]*"[^>]*>)([\s\S]*?)(<\/p>)/gi, '$1{BODY}$3');
  out = out.replace(/(<div[^>]*class="[^"]*eyebrow-tag[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi, '$1{EYEBROW}$3');
  out = out.replace(/(<div[^>]*class="[^"]*hero-stat-value[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi, '$1{STAT_VALUE}$3');
  return out;
}

function buildSkeletonCache(projectRoot = PROJECT_ROOT) {
  if (_skeletonCache) return _skeletonCache;
  loadSlideTemplateRegistry({ projectRoot, forceReload: true });
  const html = loadShowcaseHtml(projectRoot);
  const cache = new Map();
  const reg = loadSlideTemplateRegistry({ projectRoot });
  for (const t of reg.templates) {
    const raw = extractSlideRootFromSection(html, t.id);
    if (raw) cache.set(t.id, tokenizeSkeletonCopy(raw.trim()));
  }
  _skeletonCache = cache;
  return cache;
}

/**
 * @param {string} templateId Showcase section id
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {boolean} [opts.tokenize] Default true
 */
function getShowcaseTemplateSkeleton(templateId, opts = {}) {
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  if (opts.tokenize === false) {
    return extractSlideRootFromSection(loadShowcaseHtml(projectRoot), templateId);
  }
  const cache = buildSkeletonCache(projectRoot);
  return cache.get(String(templateId)) || null;
}

function getShowcaseTemplateSkeletonForRouting(routing, opts = {}) {
  const templateId = routing?.templateId || routing?.showcaseTemplateId;
  if (!templateId) return null;
  const meta = getTemplateById(templateId, opts);
  const skeleton = getShowcaseTemplateSkeleton(templateId, opts);
  if (!skeleton || !meta) return null;
  return { ...meta, skeletonHtml: skeleton };
}

function clearSkeletonCache() {
  _skeletonCache = null;
}

module.exports = {
  loadShowcaseHtml,
  extractSlideRootFromSection,
  tokenizeSkeletonCopy,
  buildSkeletonCache,
  getShowcaseTemplateSkeleton,
  getShowcaseTemplateSkeletonForRouting,
  clearSkeletonCache,
};
