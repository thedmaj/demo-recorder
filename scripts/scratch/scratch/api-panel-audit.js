#!/usr/bin/env node
'use strict';
/**
 * api-panel-audit.js — pipeline stage
 *
 * Validates the API panel JSON shown on-screen (the `apiResponse` blocks in
 * demo-script.json) against Plaid's real contracts. Catches fabricated fields,
 * wrong types/shapes, masked-Auth-account, and other accuracy defects that the
 * vision QA (build-qa) doesn't check. FLAG-ONLY: never rewrites curated values.
 *
 * Runs after `post-panels` (panels final; artifacts/live-api-responses.json
 * present from live-api-capture). Ground truth, most-authoritative first:
 *   1. live-capture diff (artifacts/live-api-responses.json, live:true)
 *   2. AskBill canonical field list (cached in inputs/api-contracts-cache.json)
 *      for endpoints live-capture can't exercise (async CRA reports, etc.)
 *   3. deterministic format/shape/enum rules (utils/api-panel-validator.js)
 *
 * Writes:
 *   <runDir>/api-panel-audit.json        — full report (qa-shaped)
 *   <runDir>/api-panel-audit-task.md     — agent-ready fix checklist (when HIGH/MED)
 *   inputs/api-contracts-cache.json      — AskBill field-list cache (repo-level)
 *
 * Gating is owned by the orchestrator (warn + agent-task by default;
 * API_PANEL_AUDIT_STRICT=true → hard-fail). This module returns a report and
 * never throws on missing artifacts / AskBill unavailability.
 *
 * Env:
 *   API_PANEL_AUDIT_NO_ASKBILL=true       — skip AskBill (live + deterministic only)
 *   API_PANEL_AUDIT_CACHE_TTL_DAYS=30     — refresh cached contracts older than this
 *   API_PANEL_AUDIT_STRICT=true           — (read by orchestrator) hard-fail on HIGH
 */

require('../utils/load-env').loadEnv();

const fs = require('fs');
const path = require('path');
const { auditApiPanels, normalizeEndpoint } = require('../utils/api-panel-validator');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const CACHE_PATH = path.join(PROJECT_ROOT, 'inputs', 'api-contracts-cache.json');
const CACHE_TTL_DAYS = parseFloat(process.env.API_PANEL_AUDIT_CACHE_TTL_DAYS || '30');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

/** Parse an AskBill json_sample answer into an object (strip fences/prose). */
function parseJsonSample(answer) {
  if (!answer || typeof answer !== 'string') return null;
  if (/^\s*\[AskBill unavailable\]/i.test(answer)) return null;
  let s = answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  // Extract the first balanced {...} or [...] block if there's surrounding prose.
  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) start = firstObj;
  else if (firstArr >= 0) start = firstArr;
  if (start < 0) return null;
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (_) { return null; }
}

/**
 * Build contractSamples (parsed canonical JSON trees) for endpoints with NO
 * live-capture ground truth, via a repo-level cache backed by AskBill json_sample.
 * A real JSON tree is far more reliable than a noisy field-name list for diffing.
 */
async function resolveContractSamples(endpointsNeedingAskBill) {
  const result = {};
  if (!endpointsNeedingAskBill.length) return result;

  const cache = readJsonSafe(CACHE_PATH) || { contracts: {} };
  if (!cache.contracts) cache.contracts = {};
  let cacheDirty = false;
  const noAskBill = String(process.env.API_PANEL_AUDIT_NO_ASKBILL || '').toLowerCase() === 'true';
  const ttlMs = CACHE_TTL_DAYS * 86400000;

  let askPlaidDocs = null;
  try { ({ askPlaidDocs } = require('../utils/mcp-clients')); } catch (_) { askPlaidDocs = null; }

  for (const ep of endpointsNeedingAskBill) {
    const entry = cache.contracts[ep];
    const fresh = entry && entry.sample && typeof entry.sample === 'object' && entry.fetchedAt
      && (nowMs() - Date.parse(entry.fetchedAt) < ttlMs);
    if (fresh) { result[ep] = entry.sample; continue; }
    if (noAskBill || !askPlaidDocs) continue; // skip → endpoint gets deterministic-only

    let answer = '[AskBill unavailable]';
    try {
      answer = await askPlaidDocs(
        `Return a realistic, complete example JSON response body for a successful Plaid ${ep} call, ` +
        `using only real documented fields with correct nesting and types.`,
        { answerFormat: 'json_sample' }
      );
    } catch (_) { /* never throw */ }
    const sample = parseJsonSample(answer);
    if (sample) {
      result[ep] = sample;
      cache.contracts[ep] = { sample, fetchedAt: nowIso() };
      cacheDirty = true;
      console.log(`[api-panel-audit] AskBill canonical sample cached for ${ep}`);
    } else {
      console.warn(`[api-panel-audit] AskBill returned no usable JSON sample for ${ep} — endpoint skipped (deterministic checks only)`);
    }
  }

  if (cacheDirty) {
    try {
      cache.updatedAt = nowIso();
      const tmp = CACHE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, CACHE_PATH);
    } catch (e) { console.warn(`[api-panel-audit] Could not write contract cache: ${e.message}`); }
  }
  return result;
}

// Date.now()/new Date() are fine in a stage script (only workflow scripts ban them).
function nowMs() { return Date.now(); }
function nowIso() { return new Date().toISOString(); }

function writeTaskMd(runDir, runId, report) {
  const flagged = report.blocks.filter(b => b.findings.some(f => f.severity === 'HIGH' || f.severity === 'MED'));
  if (!flagged.length) return null;
  const L = [];
  L.push(`# API panel accuracy — ${runId}\n`);
  L.push(`> The on-screen API panels below contain field/type/shape inaccuracies vs Plaid's real contracts. ` +
    `Fix them in \`demo-script.json\` (\`steps[].apiResponse.response\`) — that JSON is copied **verbatim** into the app, ` +
    `so editing it + re-running \`post-panels\` is sufficient. **Do not** change curated VALUES (names, amounts, scores) — only field names/types/shape.\n`);
  L.push(`> Summary: ${report.summary.high} HIGH · ${report.summary.med} MED across ${report.summary.blocksAudited} block(s) ` +
    `(${report.summary.major} MAJOR / ${report.summary.minor} MINOR / ${report.summary.accurate} ACCURATE).\n`);
  for (const b of flagged) {
    L.push(`## \`${b.stepId}\` — ${b.endpoint}  [${b.verdict}, ground-truth: ${b.groundTruth}]\n`);
    for (const f of b.findings) {
      if (f.severity === 'LOW') continue;
      L.push(`- **[${f.severity}] \`${f.path}\`** — ${f.problem}`);
      if (f.correctedShape) L.push(`  - Fix: ${f.correctedShape}  _(source: ${f.source})_`);
    }
    L.push('');
  }
  L.push(`## Editing contract\n`);
  L.push(`- Edit \`demo-script.json\` directly (Read + Edit). Preserve schema; keep curated values.`);
  L.push(`- After edits: \`npm run pipe -- stage post-panels ${runId}\` (re-injects panels verbatim).`);
  L.push(`- If the run was already recorded, re-record from \`--from=set-recording-dwells\`.`);
  L.push(`- Do NOT touch \`build-app.js\` / \`post-panels.js\`. Re-run \`npm run pipe -- stage api-panel-audit ${runId}\` to confirm.\n`);
  const taskPath = path.join(runDir, 'api-panel-audit-task.md');
  try { fs.writeFileSync(taskPath, L.join('\n'), 'utf8'); } catch (_) { return null; }
  return taskPath;
}

async function main() {
  const runDir = OUT_DIR;
  const demoScript = readJsonSafe(path.join(runDir, 'demo-script.json'));
  if (!demoScript || !Array.isArray(demoScript.steps)) {
    console.log('[api-panel-audit] No demo-script.json — skipping.');
    return { skipped: true, reason: 'no-demo-script', passed: true };
  }
  const apiSteps = demoScript.steps.filter(s => s && s.apiResponse && s.apiResponse.endpoint && s.apiResponse.response);
  if (!apiSteps.length) {
    console.log('[api-panel-audit] No apiResponse blocks — skipping.');
    return { skipped: true, reason: 'no-api-panels', passed: true };
  }

  const liveResponses = readJsonSafe(path.join(runDir, 'artifacts', 'live-api-responses.json')) || { responses: {} };
  const liveEndpoints = new Set(
    Object.values(liveResponses.responses || {})
      .filter(v => v && v.live && v.endpoint)
      .map(v => normalizeEndpoint(v.endpoint))
  );

  // Fetch AskBill canonical samples for ALL distinct endpoints (cached). For
  // live-captured endpoints these RESCUE real fields the sandbox omits (so we
  // don't false-flag e.g. /auth/get verification_status); for live-skipped
  // endpoints (async CRA) they are the primary ground truth.
  const allEndpoints = Array.from(new Set(
    apiSteps.map(s => normalizeEndpoint(s.apiResponse.endpoint))
  ));
  const contractSamples = await resolveContractSamples(allEndpoints);

  const { blocks, summary } = auditApiPanels({ demoScript, liveResponses, contractSamples });
  const threshold = 0; // any HIGH fails; surfaced via summary
  const passed = summary.high === 0;
  const report = {
    generatedAt: nowIso(),
    passed,
    threshold,
    liveEndpoints: Array.from(liveEndpoints),
    askbillEndpoints: Object.keys(contractSamples),
    summary,
    blocks,
  };
  const reportPath = path.join(runDir, 'api-panel-audit.json');
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8'); } catch (_) {}

  const runId = path.basename(runDir);
  const taskPath = writeTaskMd(runDir, runId, report);

  // Human-readable console summary.
  console.log(`[api-panel-audit] ${summary.blocksAudited} block(s): ${summary.major} MAJOR, ${summary.minor} MINOR, ${summary.accurate} ACCURATE ` +
    `(${summary.high} HIGH, ${summary.med} MED findings).`);
  for (const b of blocks) {
    if (b.verdict === 'ACCURATE') continue;
    console.log(`  [${b.verdict}] ${b.stepId} (${b.endpoint}) — ${b.findings.length} finding(s) [${b.groundTruth}]`);
    for (const f of b.findings) if (f.severity !== 'LOW') console.log(`     ${f.severity} ${f.path}: ${f.problem}`);
  }
  if (taskPath) console.log(`[api-panel-audit] Fix checklist: ${path.relative(PROJECT_ROOT, taskPath)}`);
  if (passed) console.log('[api-panel-audit] No HIGH-severity API panel inaccuracies.');

  return { passed, skipped: false, summary, taskPath, reportPath, findingCount: summary.high + summary.med };
}

if (require.main === module) {
  main().catch(err => {
    console.error('[api-panel-audit] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, parseJsonSample };
