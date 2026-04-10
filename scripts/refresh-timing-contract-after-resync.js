#!/usr/bin/env node
'use strict';

/**
 * refresh-timing-contract-after-resync.js
 *
 * After resync-audio remaps clip compStartMs via sync-map.json, timing-contract.json
 * still reflects comp windows from the last auto-gap run. validate-narration-sync then
 * compares fresh manifest positions to stale windows → narration-screen-mismatch /
 * cross-screen-owner false positives.
 *
 * Rebuilds each contract step's compStartMs/compEndMs from sync-map segment bounds
 * (_step), using the same monotonic cursor rule as auto-gap (no overlap in comp time).
 * Steps with no tagged segments keep their previous comp *duration* and pack after prevEnd.
 *
 * Usage:
 *   PIPELINE_RUN_DIR=out/demos/… node scripts/refresh-timing-contract-after-resync.js
 *
 * Env:
 *   SKIP_TIMING_CONTRACT_REFRESH_AFTER_RESYNC=1 — no-op (escape hatch)
 */

const fs = require('fs');
const path = require('path');
const { loadSyncMap } = require('./sync-map-utils');
const { loadTimingContract, writeTimingContract } = require('./timing-contract');

function toNum(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/**
 * @param {string} runDir
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, updatedSteps?: number }}
 */
function refreshTimingContractAfterResync(runDir) {
  if (process.env.SKIP_TIMING_CONTRACT_REFRESH_AFTER_RESYNC === '1' || process.env.SKIP_TIMING_CONTRACT_REFRESH_AFTER_RESYNC === 'true') {
    return { ok: true, skipped: true, reason: 'SKIP_TIMING_CONTRACT_REFRESH_AFTER_RESYNC' };
  }

  const contract = loadTimingContract(runDir);
  if (!contract || !Array.isArray(contract.steps) || contract.steps.length === 0) {
    return { ok: false, reason: 'missing-or-empty-timing-contract' };
  }

  const syncMap = loadSyncMap(runDir);
  if (!syncMap.length) {
    return { ok: true, skipped: true, reason: 'identity-sync-map-no-segments' };
  }

  const toleranceMs = toNum(contract.defaults?.NARRATION_SYNC_TOLERANCE_MS, 250);

  /** @type {Record<string, { minCs: number, maxCe: number }>} */
  const byStep = {};
  for (const seg of syncMap) {
    const id = seg && seg._step != null ? String(seg._step).trim() : '';
    if (!id) continue;
    const cs = toNum(seg.compStart) * 1000;
    const ce = toNum(seg.compEnd) * 1000;
    if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) continue;
    if (!byStep[id]) {
      byStep[id] = { minCs: cs, maxCe: ce };
    } else {
      byStep[id].minCs = Math.min(byStep[id].minCs, cs);
      byStep[id].maxCe = Math.max(byStep[id].maxCe, ce);
    }
  }

  let prevEnd = 0;
  let updated = 0;

  for (const row of contract.steps) {
    const stepId = String(row.stepId || '').trim();
    if (!stepId) continue;

    const geo = byStep[stepId];
    let compStartMs;
    let compEndMs;

    if (geo) {
      const span = Math.max(0, geo.maxCe - geo.minCs);
      const cs = Math.max(geo.minCs, prevEnd);
      const ce = cs + span;
      compStartMs = cs;
      compEndMs = ce;
    } else {
      const prevDur = Math.max(0, toNum(row.compEndMs) - toNum(row.compStartMs));
      compStartMs = prevEnd;
      compEndMs = prevEnd + prevDur;
    }

    const oS = toNum(row.compStartMs);
    const oE = toNum(row.compEndMs);
    if (Math.round(compStartMs) !== Math.round(oS) || Math.round(compEndMs) !== Math.round(oE)) {
      updated++;
    }

    row.compStartMs = Math.round(compStartMs);
    row.compEndMs = Math.round(compEndMs);
    prevEnd = row.compEndMs;

    const targetCompDurationMs = Math.max(0, toNum(row.targetCompDurationMs));
    const actualCompDurationMs = Math.max(0, row.compEndMs - row.compStartMs);
    row.actualCompDurationMs = actualCompDurationMs;
    row.deltaMs = Math.round(actualCompDurationMs - targetCompDurationMs);
    row.status = actualCompDurationMs + toleranceMs >= targetCompDurationMs ? 'ok' : 'overrun';
  }

  const violations = contract.steps.filter((s) => s.status !== 'ok');
  contract.generatedAt = new Date().toISOString();
  const srcBase = String(contract.source || 'auto-gap').replace(/\+post-resync-window-refresh$/i, '');
  contract.source = `${srcBase}+post-resync-window-refresh`;
  contract.summary = {
    totalSteps: contract.steps.length,
    okSteps: contract.steps.length - violations.length,
    overrunSteps: violations.length,
    plaidLinkSteps: contract.steps.filter((s) => s.isPlaidLink).length,
    plaidLinkOverruns: contract.steps.filter((s) => s.isPlaidLink && s.status !== 'ok').length,
    maxOverrunMs: violations.reduce((m, s) => Math.max(m, Math.abs(toNum(s.deltaMs))), 0),
  };

  writeTimingContract(runDir, contract);
  return { ok: true, updatedSteps: updated };
}

function main() {
  const runDir = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
  const r = refreshTimingContractAfterResync(runDir);
  if (!r.ok) {
    console.error(`[refresh-timing-contract] ${r.reason || 'failed'}`);
    process.exit(1);
  }
  if (r.skipped) {
    console.log(`[refresh-timing-contract] Skipped: ${r.reason}`);
  } else {
    console.log(`[refresh-timing-contract] OK — refreshed comp windows (${r.updatedSteps || 0} step(s) changed)`);
  }
}

module.exports = { refreshTimingContractAfterResync };

if (require.main === module) {
  main();
}
