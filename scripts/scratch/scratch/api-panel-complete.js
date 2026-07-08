#!/usr/bin/env node
'use strict';
/**
 * api-panel-complete.js — pipeline stage (OPT-IN, off by default)
 *
 * Completes each on-screen JSON API panel (`apiResponse.response` in
 * demo-script.json) toward the full CANONICAL Plaid response shape, then
 * re-injects via post-panels. Runs after `api-panel-audit` (which populates the
 * AskBill canonical-sample cache) and BEFORE `record` (panels are baked into the
 * recorded app).
 *
 * Design (per code review — deterministic, structure-only; NOT an LLM rewrite):
 *   #1 STRUCTURE-ONLY COMPLETION: add the canonical fields the demo is MISSING
 *      (real ref−demo diff), with NEUTRAL TYPED PLACEHOLDERS. NEVER overwrite a
 *      curated value. Recurse objects; complete EVERY existing array element
 *      (not just [0]). Idempotent (deterministic; re-run adds nothing new).
 *   #3 KNOWN CORRECTIONS: a narrow, endpoint-keyed, AskBill-verified value pass
 *      (e.g. LendScore: drop the non-canonical `score_range`; make reason_codes
 *      the canonical opaque codes — humanized text belongs on the slide, not the
 *      raw panel).
 *
 * Guardrails:
 *   - HARD SKIP live-captured steps (`live:true`) — a live response is already
 *     authoritative; completing it would re-bloat + then read as fabricated.
 *   - HARD SKIP endpoints with no canonical sample (no ground truth).
 *   - SIZE CEILING: if a completed panel exceeds API_PANEL_COMPLETE_MAX_CHARS,
 *     revert that step (keep curated) so the panel stays readable.
 *   - Never throws on missing artifacts / bad JSON — warn + leave original.
 *
 * Env:
 *   API_PANEL_COMPLETE=true            enable this stage (default OFF)
 *   API_PANEL_COMPLETE_MAX_CHARS=8000  per-panel size ceiling (JSON chars)
 *   API_PANEL_COMPLETE_NO_CORRECTIONS  set to skip the #3 known-corrections pass
 */

require('../utils/load-env').loadEnv();
const fs = require('fs');
const path = require('path');
const { normalizeEndpoint } = require('../utils/api-panel-validator');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const CACHE_PATH = path.join(PROJECT_ROOT, 'inputs', 'api-contracts-cache.json');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// ── #1 structure-only completion ─────────────────────────────────────────────

// A missing NUMERIC leaf is OMITTED, never fabricated: a `0` on an on-screen
// panel reads as a real (often alarming) value — e.g. `days_available: 0`,
// `average_balance: 0`, `score: 0` (code review #1). Strings/currency/null/bool
// are visibly-empty or structural, so they're safe to add.
const OMIT = Symbol('omit-field');

/** Neutral placeholder for a field the demo is MISSING, matching the ref type.
 *  We deliberately do NOT copy the reference's persona-specific value (a sample
 *  `average_balance: 4956.12` would contradict the demo persona), and we OMIT
 *  numeric leaves entirely rather than fabricate a misleading number. */
function placeholderFromRef(refVal, key) {
  if (Array.isArray(refVal)) return []; // never fabricate list items
  if (refVal && typeof refVal === 'object') {
    const o = {};
    for (const k of Object.keys(refVal)) {
      const v = placeholderFromRef(refVal[k], k);
      if (v !== OMIT) o[k] = v;
    }
    return o;
  }
  if (/(^|_)iso_currency_code$/i.test(key)) return 'USD';
  if (/(^|_)unofficial_currency_code$/i.test(key)) return null;
  if (refVal === null) return null;
  if (typeof refVal === 'number') return OMIT; // never fabricate a numeric value
  if (typeof refVal === 'boolean') return false;
  return ''; // string placeholder — do not fabricate ids/dates/descriptions
}

/** Return a NEW value = demo completed toward ref's shape. Preserves every demo
 *  value (curated); only ADDS keys the demo lacks. Records added paths in `added`.
 *  Arrays: complete every existing demo element against ref[0]; never change count. */
function completeToRef(demo, ref, added, pathPrefix) {
  if (Array.isArray(ref)) {
    if (!Array.isArray(demo)) return demo;            // shape mismatch → leave demo
    const elemRef = ref.length ? ref[0] : null;
    if (!elemRef || typeof elemRef !== 'object') return demo; // scalar array → leave
    return demo.map((el, i) => completeToRef(el, elemRef, added, `${pathPrefix}[${i}]`));
  }
  if (ref && typeof ref === 'object') {
    if (!demo || typeof demo !== 'object' || Array.isArray(demo)) return demo; // mismatch
    const out = { ...demo };
    for (const k of Object.keys(ref)) {
      const childPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        out[k] = completeToRef(out[k], ref[k], added, childPath); // recurse; keep curated leaves
      } else {
        const v = placeholderFromRef(ref[k], k);
        if (v === OMIT) continue; // omit fabricated numeric leaves (review #1)
        out[k] = v;
        added.push(childPath);
      }
    }
    return out;
  }
  return demo; // scalar demo leaf → keep curated value
}

// ── #3 known, AskBill-verified corrections (narrow; endpoint-keyed) ───────────

function applyKnownCorrections(endpoint, resp, refTree, corrected) {
  const ep = normalizeEndpoint(endpoint || '');
  if (/lend_score\/get$/.test(ep)) {
    const ls = resp && resp.report && resp.report.lend_score;
    if (ls && typeof ls === 'object') {
      // score_range is NOT a documented lend_score field (AskBill-confirmed).
      if (Object.prototype.hasOwnProperty.call(ls, 'score_range')) {
        delete ls.score_range;
        corrected.push('removed report.lend_score.score_range (not a canonical field)');
      }
      // reason_codes are OPAQUE codes (e.g. PCS0221) in the raw response; any
      // humanized strings belong on the slide, not the panel. Replace with the
      // canonical opaque codes from the AskBill sample, preserving the count.
      const refCodes = refTree && refTree.report && refTree.report.lend_score &&
        refTree.report.lend_score.reason_codes;
      const opaque = (c) => /^[A-Z]{2,5}\d{2,6}$/.test(String(c));
      // Only remap when EVERY element is a string (don't flatten object-shaped
      // codes into "[object Object]"), and TRUNCATE to the canonical list rather
      // than cycling (cycling emits duplicate adverse-action codes — review #2).
      if (Array.isArray(ls.reason_codes) &&
          ls.reason_codes.every((c) => typeof c === 'string') &&
          ls.reason_codes.some((c) => !opaque(c)) &&
          Array.isArray(refCodes) && refCodes.length) {
        ls.reason_codes = refCodes.slice(0, ls.reason_codes.length);
        corrected.push('replaced humanized lend_score.reason_codes with canonical opaque codes');
      }
    }
  }
  return resp;
}

// ── Per-step + whole-script drivers ──────────────────────────────────────────

/** Ground truth for a step: 'live' (skip), 'canonical' (complete), or 'none'. */
function groundTruthFor(step, liveResponses, contractSamples) {
  const live = liveResponses && liveResponses.responses && liveResponses.responses[step.id];
  // Live-captured steps are authoritative — HARD-SKIP even if the capture body is
  // empty (completing a `live:true` step would then read as fabricated). review #6
  if (live && live.live === true) return { kind: 'live' };
  const ep = normalizeEndpoint(step.apiResponse && step.apiResponse.endpoint || '');
  const sample = contractSamples && contractSamples[ep];
  if (sample && typeof sample === 'object') return { kind: 'canonical', ref: sample };
  return { kind: 'none' };
}

function completeApiPanels({ demoScript, liveResponses, contractSamples, maxChars = 8000, corrections = true } = {}) {
  const report = { completed: [], skipped: [] };
  const steps = (demoScript && Array.isArray(demoScript.steps)) ? demoScript.steps : [];
  for (const step of steps) {
    const ar = step && step.apiResponse;
    if (!ar || !ar.endpoint || !ar.response || typeof ar.response !== 'object') continue;
    const gt = groundTruthFor(step, liveResponses, contractSamples);
    if (gt.kind !== 'canonical') {
      report.skipped.push({ id: step.id, reason: gt.kind === 'live' ? 'live-captured (authoritative)' : 'no canonical ground truth' });
      continue;
    }
    const before = JSON.stringify(ar.response);
    const added = [];
    const corrected = [];
    // #1 — structure-only completion (deep clone via completeToRef; preserves curated)
    let next = completeToRef(JSON.parse(before), gt.ref, added, '');
    // #3 — narrow verified corrections
    if (corrections) next = applyKnownCorrections(ar.endpoint, next, gt.ref, corrected);

    const after = JSON.stringify(next);
    if (after === before) { report.skipped.push({ id: step.id, reason: 'already complete (no-op)' }); continue; }
    if (after.length > maxChars) {
      report.skipped.push({ id: step.id, reason: `would exceed size ceiling (${after.length} > ${maxChars} chars) — kept curated` });
      continue;
    }
    ar.response = next;
    report.completed.push({ id: step.id, endpoint: normalizeEndpoint(ar.endpoint), addedFields: added, corrections: corrected });
  }
  return { demoScript, report };
}

// ── Stage main ────────────────────────────────────────────────────────────────

async function main() {
  const runDir = OUT_DIR;
  if (String(process.env.API_PANEL_COMPLETE || 'false').toLowerCase() !== 'true') {
    console.log('[api-panel-complete] disabled (set API_PANEL_COMPLETE=true to enable) — skipping.');
    return { skipped: true, reason: 'disabled', passed: true };
  }
  const scriptPath = path.join(runDir, 'demo-script.json');
  const demoScript = readJsonSafe(scriptPath);
  if (!demoScript) { console.log('[api-panel-complete] No demo-script.json — skipping.'); return { skipped: true, passed: true }; }

  const liveResponses = readJsonSafe(path.join(runDir, 'artifacts', 'live-api-responses.json')) || { responses: {} };
  const cache = readJsonSafe(CACHE_PATH) || { contracts: {} };
  const contractSamples = {};
  for (const [ep, entry] of Object.entries(cache.contracts || {})) {
    const sample = entry && (entry.sample || entry.json_sample || entry.response);
    if (sample && typeof sample === 'object') contractSamples[normalizeEndpoint(ep)] = sample;
  }

  const _mc = parseInt(process.env.API_PANEL_COMPLETE_MAX_CHARS || '8000', 10);
  const maxChars = Number.isFinite(_mc) ? _mc : 8000; // a typo'd env must not disable the ceiling (review #5)
  const corrections = String(process.env.API_PANEL_COMPLETE_NO_CORRECTIONS || '').toLowerCase() !== 'true';
  const { report } = completeApiPanels({ demoScript, liveResponses, contractSamples, maxChars, corrections });

  if (report.completed.length === 0) {
    console.log(`[api-panel-complete] nothing to complete (${report.skipped.length} step(s) skipped).`);
    return { skipped: true, passed: true, report };
  }

  // Persist + re-inject into the app via post-panels (panels are copied verbatim).
  const tmp = scriptPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(demoScript, null, 2), 'utf8');
  fs.renameSync(tmp, scriptPath);
  for (const c of report.completed) {
    console.log(`[api-panel-complete] ${c.id} (${c.endpoint}): +${c.addedFields.length} field(s)${c.corrections.length ? `, ${c.corrections.length} correction(s)` : ''}`);
  }
  // Pre-check inputs post-panels needs: its main() calls process.exit(1) on a
  // missing app/script, which is NOT catchable and would hard-kill the pipeline
  // (review #3). Only invoke it when both files exist.
  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  if (!fs.existsSync(htmlPath) || !fs.existsSync(scriptPath)) {
    console.warn('[api-panel-complete] scratch-app/index.html or demo-script.json missing — updated demo-script only; run `pipe stage post-panels` to re-inject.');
  } else {
    try {
      delete require.cache[require.resolve('./post-panels.js')];
      const pp = require('./post-panels.js');
      if (typeof pp.main === 'function') { await pp.main(); console.log('[api-panel-complete] re-injected panels via post-panels.'); }
      else console.warn('[api-panel-complete] post-panels has no main() — run `pipe stage post-panels` to re-inject.');
    } catch (e) {
      console.warn(`[api-panel-complete] post-panels re-inject failed (${e.message}) — run \`pipe stage post-panels\` manually.`);
    }
  }
  fs.writeFileSync(path.join(runDir, 'api-panel-complete.json'), JSON.stringify(report, null, 2));
  return { passed: true, report };
}

module.exports = {
  main,
  // exported for unit tests:
  completeToRef,
  placeholderFromRef,
  applyKnownCorrections,
  completeApiPanels,
  groundTruthFor,
};

if (require.main === module) {
  main().catch((err) => { console.error('[api-panel-complete] Fatal:', err.message); process.exit(1); });
}
