'use strict';

/**
 * layer-build-patches.js
 *
 * Deterministic post-build hardening for the recurring LLM misses observed on
 * real-Plaid-Layer + brand-disclosure demos. Applied by post-panels (which runs
 * after build, before build-qa) so the fixes land before the deterministic gate —
 * no manual touch-up cycle needed.
 *
 *  1. fixLayerTokenEndpoint   — real-Layer apps must obtain the Layer session
 *     token from /api/create-session-token (NOT the standard /api/create-link-token
 *     the LLM tends to default to). See plaid-layer-idv-onboarding skill.
 *  2. ensureBrandDisclosureFooter — inject the brand's verbatim regulatory
 *     disclosures (brand.footer.disclosures + copyright + nmlsId) when the LLM
 *     omitted them, preventing the build-qa `brand-disclosure-missing` blocker.
 *
 * Both are idempotent and no-ops when not applicable.
 */

const fs = require('fs');
const path = require('path');

/** Detect a real Plaid Layer (Web SDK) demo — Layer product with a launch step. */
function isRealLayerDemo(demoScript) {
  if (!demoScript) return false;
  const product = String(demoScript.product || '').toLowerCase();
  const flow = String(
    (demoScript.plaidSandboxConfig && demoScript.plaidSandboxConfig.plaidLinkFlow) || ''
  ).toLowerCase();
  const hasLaunch =
    Array.isArray(demoScript.steps) &&
    demoScript.steps.some((s) => String((s && s.plaidPhase) || '').toLowerCase() === 'launch');
  const layerSignaled = product.includes('layer') || flow === 'layer' || flow === 'layer-web-sdk';
  return layerSignaled && hasLaunch;
}

/**
 * Patch 1 — real-Layer token endpoint. Rewrites any /api/create-link-token fetch to
 * /api/create-session-token for real-Layer demos. The Layer session endpoint reads
 * client_user_id/template_id and ignores the legacy link-token body fields.
 */
function fixLayerTokenEndpoint(html, demoScript) {
  if (typeof html !== 'string' || !isRealLayerDemo(demoScript)) return { html, changed: false };
  if (!html.includes('/api/create-link-token')) return { html, changed: false };
  const next = html.split('/api/create-link-token').join('/api/create-session-token');
  return { html: next, changed: next !== html };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Load the brand profile written by brand-extract (artifacts/brand/<slug>.json). */
function loadBrandProfile(runDir) {
  try {
    const dir = path.join(runDir || process.env.PIPELINE_RUN_DIR || '', 'artifacts', 'brand');
    if (!fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') && !/brand-extract\.json$/.test(f)) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (j && j.footer) return j;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Patch 2 — ensure the host HTML carries the brand's verbatim regulatory
 * disclosures. Injects a host-scoped footer (hidden when a slide step is active)
 * before </body> only when one or more expected strings are missing. Idempotent.
 *
 * @param {string} html
 * @param {object} [opts] - { brandProfile?, runDir? }
 */
function ensureBrandDisclosureFooter(html, opts = {}) {
  if (typeof html !== 'string') return { html, changed: false };
  if (html.includes('data-testid="pipeline-brand-disclosure"')) return { html, changed: false };
  const brand = opts.brandProfile || loadBrandProfile(opts.runDir);
  const footer = brand && brand.footer;
  if (!footer) return { html, changed: false };

  const disclosures = Array.isArray(footer.disclosures) ? footer.disclosures.filter(Boolean) : [];
  const expected = [...disclosures, footer.copyright, footer.nmlsId].filter(Boolean);
  if (!expected.length) return { html, changed: false };

  const text = normalizeForCompare(html.replace(/<[^>]+>/g, ' '));
  const missing = expected.filter((e) => !text.includes(normalizeForCompare(e)));
  if (!missing.length) return { html, changed: false };

  // First line: disclosures + NMLS on one row; copyright on its own row.
  const primary = [...disclosures, footer.nmlsId].filter(Boolean).join(' ');
  const copyright = footer.copyright || '';
  const block =
    '\n<style data-pipeline-brand-disclosure="1">' +
    '[data-testid="pipeline-brand-disclosure"]{padding:14px 32px;border-top:1px solid #e5e5e5;' +
    'font-size:11px;line-height:1.6;color:#888;background:#f8f9fa}' +
    'body:has(.step.active .slide-root) [data-testid="pipeline-brand-disclosure"]{display:none}' +
    '</style>\n' +
    '<footer class="pipeline-brand-disclosure" data-testid="pipeline-brand-disclosure">' +
    (primary ? '<div>' + escapeHtml(primary) + '</div>' : '') +
    (copyright ? '<div>' + escapeHtml(copyright) + '</div>' : '') +
    '</footer>\n';

  const next = html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + block;
  return { html: next, changed: true, injected: missing };
}

module.exports = {
  isRealLayerDemo,
  fixLayerTokenEndpoint,
  ensureBrandDisclosureFooter,
  loadBrandProfile,
};
