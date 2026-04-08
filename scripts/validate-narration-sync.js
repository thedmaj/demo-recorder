#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadTimingContract } = require('./timing-contract');

function toFinite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function validateNarrationSync(runDir, opts = {}) {
  const minVisualLeadMs = Number.isFinite(Number(opts.minVisualLeadMs))
    ? Number(opts.minVisualLeadMs)
    : Number(process.env.NARRATION_MIN_VISUAL_LEAD_MS || 250);
  const boundaryToleranceMs = Number.isFinite(Number(opts.boundaryToleranceMs))
    ? Number(opts.boundaryToleranceMs)
    : Number(process.env.NARRATION_WINDOW_TOLERANCE_MS || 120);
  const hardFailEarlyLead = (process.env.NARRATION_MIN_VISUAL_LEAD_HARD || '').toLowerCase() === 'true';

  const timing = loadTimingContract(runDir);
  const manifestPath = path.join(runDir, 'voiceover-manifest.json');
  const manifest = loadJsonIfExists(manifestPath);

  const violations = [];
  const warnings = [];

  if (!timing || !Array.isArray(timing.steps)) {
    violations.push({
      code: 'missing-timing-contract',
      message: 'timing-contract.json missing or invalid.',
    });
  }
  if (!manifest || !Array.isArray(manifest.clips)) {
    violations.push({
      code: 'missing-voiceover-manifest',
      message: 'voiceover-manifest.json missing or invalid.',
    });
  }
  if (violations.length > 0) {
    return { ok: false, violations, warnings, checkedAt: new Date().toISOString() };
  }

  const steps = timing.steps;
  const clips = manifest.clips;
  const byStepId = new Map();
  for (const s of steps) {
    const id = String(s?.stepId || '').trim();
    if (!id) continue;
    if (!byStepId.has(id)) byStepId.set(id, []);
    byStepId.get(id).push(s);
  }

  for (const [stepId, rows] of byStepId.entries()) {
    if (rows.length > 1) {
      violations.push({
        code: 'duplicate-step-window',
        stepId,
        count: rows.length,
        message: `Step "${stepId}" has ${rows.length} timing windows.`,
      });
    }
  }

  for (const s of steps) {
    if (s?.status === 'overrun') {
      violations.push({
        code: 'narration-overrun',
        stepId: s.stepId || '',
        deltaMs: Number(s.deltaMs || 0),
        message: `Narration overrun for "${s.stepId || 'unknown'}": ${Number(s.deltaMs || 0)}ms`,
      });
    }
  }

  for (const clip of clips) {
    const stepId = String(clip?.id || '').trim();
    if (!stepId) continue;
    const clipStartMs =
      toFinite(clip.compStartMs) ??
      toFinite(clip.startMs) ??
      null;
    if (clipStartMs == null) continue;

    const ownRows = byStepId.get(stepId) || [];
    if (ownRows.length === 0) {
      violations.push({
        code: 'clip-missing-step-window',
        stepId,
        clipStartMs,
        message: `Narration clip "${stepId}" has no timing-contract window.`,
      });
      continue;
    }

    const inOwnWindow = ownRows.some((w) => {
      const start = toFinite(w.compStartMs);
      const end = toFinite(w.compEndMs);
      if (start == null || end == null) return false;
      return clipStartMs >= (start - boundaryToleranceMs) && clipStartMs <= (end + boundaryToleranceMs);
    });
    if (!inOwnWindow) {
      violations.push({
        code: 'narration-screen-mismatch',
        stepId,
        clipStartMs,
        ownWindows: ownRows.map((w) => [Number(w.compStartMs || 0), Number(w.compEndMs || 0)]),
        message: `Narration for "${stepId}" starts outside its own screen window.`,
      });
      continue;
    }

    const canonical = ownRows[0];
    const windowStartMs = toFinite(canonical.compStartMs);
    if (windowStartMs != null && clipStartMs < (windowStartMs + minVisualLeadMs)) {
      const earlyIssue = {
        code: 'narration-too-early',
        stepId,
        clipStartMs,
        windowStartMs,
        minVisualLeadMs,
        message: `Narration for "${stepId}" starts too early (${clipStartMs - windowStartMs}ms lead; requires >= ${minVisualLeadMs}ms).`,
      };
      if (hardFailEarlyLead) violations.push(earlyIssue);
      else warnings.push(earlyIssue);
    }

    const owner = steps.find((s) => {
      const start = toFinite(s.compStartMs);
      const end = toFinite(s.compEndMs);
      if (start == null || end == null) return false;
      // Half-open interval avoids false cross-owner at exact boundary transitions.
      return clipStartMs >= start && clipStartMs < end;
    });
    if (owner && owner.stepId && owner.stepId !== stepId) {
      violations.push({
        code: 'cross-screen-owner',
        stepId,
        ownerStepId: owner.stepId,
        clipStartMs,
        message: `Narration for "${stepId}" begins during "${owner.stepId}".`,
      });
    }
  }

  const timingGeneratedAtMs = timing?.generatedAt ? Date.parse(timing.generatedAt) : null;
  const resyncedAtMs = manifest?.resyncedAt ? Date.parse(manifest.resyncedAt) : null;
  if (timingGeneratedAtMs != null && resyncedAtMs != null && resyncedAtMs > timingGeneratedAtMs) {
    warnings.push({
      code: 'timing-older-than-manifest',
      message: 'voiceover-manifest is newer than timing-contract; validate after sync-map/audio edits.',
    });
  }

  return {
    ok: violations.length === 0,
    checkedAt: new Date().toISOString(),
    minVisualLeadMs,
    boundaryToleranceMs,
    violations,
    warnings,
  };
}

function writeReport(runDir, report) {
  const out = path.join(runDir, 'narration-sync-validation.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  return out;
}

function main() {
  const runDir = process.env.PIPELINE_RUN_DIR || path.resolve(__dirname, '../out');
  const report = validateNarrationSync(runDir);
  const out = writeReport(runDir, report);
  if (!report.ok) {
    console.error(`[narration-sync] FAILED: ${report.violations.length} violation(s)`);
    console.error(`[narration-sync] Report: ${out}`);
    for (const v of report.violations.slice(0, 20)) {
      console.error(`  - ${v.code}: ${v.message}`);
    }
    process.exit(2);
  }
  console.log(`[narration-sync] PASS (${report.warnings.length} warning(s))`);
  console.log(`[narration-sync] Report: ${out}`);
}

module.exports = {
  validateNarrationSync,
  writeReport,
  main,
};

if (require.main === module) {
  main();
}

