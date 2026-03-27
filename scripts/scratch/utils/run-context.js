'use strict';

const fs = require('fs');
const path = require('path');
const { getProductProfile } = require('./product-profiles');
const { buildCuratedProductKnowledge, buildCuratedDigest, extractSection, loadProductKnowledgeForFamily } = require('./product-knowledge');

/**
 * Collect approved-claim strings from research JSON + per-family KB markdown.
 * @param {object|null} research
 * @param {string} productFamily
 * @returns {{ fromResearch: string[], fromKnowledgeFiles: { slug: string, bullets: string[] }[] }}
 */
function buildApprovedClaimsDigest(research, productFamily) {
  const fromResearch = [];
  const si = research && research.synthesizedInsights;
  if (si && typeof si === 'object') {
    for (const key of ['valuePropositions', 'keyFeatures', 'demoTalkingPoints']) {
      const arr = si[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string' && item.trim()) fromResearch.push(item.trim());
          else if (item && typeof item === 'object' && item.text) fromResearch.push(String(item.text).trim());
        }
      }
    }
  }

  const files = loadProductKnowledgeForFamily(productFamily);
  const fromKnowledgeFiles = [];
  for (const file of files) {
    const bullets = [];
    for (const heading of ['Proof Points & ROI Metrics', 'Value Proposition Statements', 'Narration Talk Tracks']) {
      const block = extractSection(file.markdown, heading);
      if (!block) continue;
      for (const line of block.split('\n')) {
        const t = line.trim();
        if (/^[-*]\s+/.test(t)) {
          bullets.push(t.replace(/^[-*]\s+/, '').trim());
        }
      }
    }
    if (bullets.length) {
      fromKnowledgeFiles.push({ slug: file.slug, bullets: bullets.slice(0, 40) });
    }
  }

  return { fromResearch: fromResearch.slice(0, 30), fromKnowledgeFiles };
}

/**
 * @param {{
 *   phase: string,
 *   productFamily: string,
 *   productResearch: object|null,
 *   demoScript: object|null,
 *   promptText?: string,
 * }} opts
 * @param {object} [digestOptions] forwarded to buildCuratedDigest
 */
function buildRunContextPayload(opts, digestOptions = {}) {
  const {
    phase,
    productFamily,
    productResearch,
    demoScript,
    promptText = '',
  } = opts;

  const profile = getProductProfile(productFamily);
  const curated = buildCuratedProductKnowledge(productFamily);
  const curatedDigest = buildCuratedDigest(curated, digestOptions);
  const approvedClaimsDigest = buildApprovedClaimsDigest(productResearch, productFamily);

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    phase,
    productFamily,
    productProfile: {
      key: profile.key,
      label: profile.label,
      kbSlugs: profile.kbSlugs || [],
    },
    curatedProductKnowledge: curated,
    curatedDigest,
    approvedClaimsDigest,
    demoScriptSummary: demoScript
      ? {
          product: demoScript.product || '',
          title: demoScript.title || '',
          stepCount: Array.isArray(demoScript.steps) ? demoScript.steps.length : 0,
          stepIds: Array.isArray(demoScript.steps) ? demoScript.steps.map(s => s.id) : [],
        }
      : null,
    promptSnippet: (promptText || '').slice(0, 500),
  };
}

/**
 * Merge into existing pipeline-run-context.json on disk (shallow top-level merge).
 * @param {string} runDir
 * @param {object} payload
 */
function writePipelineRunContext(runDir, payload) {
  if (!runDir) return;
  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, 'pipeline-run-context.json');
  let existing = {};
  if (fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (_) {
      existing = {};
    }
  }
  const merged = {
    ...existing,
    ...payload,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
}

/**
 * @param {string} runDir
 * @returns {object|null}
 */
function readPipelineRunContext(runDir) {
  const p = path.join(runDir, 'pipeline-run-context.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = {
  buildRunContextPayload,
  buildApprovedClaimsDigest,
  writePipelineRunContext,
  readPipelineRunContext,
};
