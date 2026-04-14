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

function classifyIssueCategory(code) {
  const c = String(code || '');
  if (/^missing-/.test(c)) return 'artifact-integrity';
  if (c === 'duplicate-step-window') return 'window-integrity';
  if (c === 'narration-overrun') return 'duration-overrun';
  if (c === 'cross-screen-owner') return 'cross-screen';
  if (c === 'narration-screen-mismatch' || c === 'clip-missing-step-window') return 'placement';
  if (c === 'narration-too-early') return 'lead-lag';
  if (c === 'timing-older-than-manifest') return 'staleness';
  return 'other';
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
  const timelineRows = [];

  const pushViolation = (payload) => {
    const issue = { ...payload, category: payload?.category || classifyIssueCategory(payload?.code) };
    violations.push(issue);
  };
  const pushWarning = (payload) => {
    const issue = { ...payload, category: payload?.category || classifyIssueCategory(payload?.code) };
    warnings.push(issue);
  };

  if (!timing || !Array.isArray(timing.steps)) {
    pushViolation({
      code: 'missing-timing-contract',
      message: 'timing-contract.json missing or invalid.',
    });
  }
  if (!manifest || !Array.isArray(manifest.clips)) {
    pushViolation({
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
      pushViolation({
        code: 'duplicate-step-window',
        stepId,
        count: rows.length,
        message: `Step "${stepId}" has ${rows.length} timing windows.`,
      });
    }
  }

  for (const s of steps) {
    if (s?.status === 'overrun') {
      pushViolation({
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
    const clipStartSource =
      toFinite(clip.compStartMs) != null
        ? 'compStartMs'
        : (toFinite(clip.startMs) != null ? 'startMs' : null);
    const clipStartMs =
      toFinite(clip.compStartMs) ??
      toFinite(clip.startMs) ??
      null;
    if (clipStartMs == null) continue;

    const ownRows = byStepId.get(stepId) || [];
    if (ownRows.length === 0) {
      pushViolation({
        code: 'clip-missing-step-window',
        stepId,
        clipStartMs,
        clipStartSource,
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
      pushViolation({
        code: 'narration-screen-mismatch',
        stepId,
        clipStartMs,
        clipStartSource,
        ownWindows: ownRows.map((w) => [Number(w.compStartMs || 0), Number(w.compEndMs || 0)]),
        message: `Narration for "${stepId}" starts outside its own screen window.`,
      });
    }

    const canonical = ownRows[0];
    const windowStartMs = toFinite(canonical.compStartMs);
    const windowEndMs = toFinite(canonical.compEndMs);
    const leadMs = windowStartMs != null ? Math.round(clipStartMs - windowStartMs) : null;
    timelineRows.push({
      stepId,
      clipStartMs,
      clipStartSource,
      windowStartMs,
      windowEndMs,
      leadMs,
      inOwnWindow,
      overrunStatus: canonical?.status || 'unknown',
      boundaryToleranceMs,
      minVisualLeadMs,
    });

    if (!inOwnWindow) {
      continue;
    }

    if (windowStartMs != null && clipStartMs < (windowStartMs + minVisualLeadMs)) {
      const earlyIssue = {
        code: 'narration-too-early',
        stepId,
        clipStartMs,
        windowStartMs,
        minVisualLeadMs,
        message: `Narration for "${stepId}" starts too early (${clipStartMs - windowStartMs}ms lead; requires >= ${minVisualLeadMs}ms).`,
      };
      if (hardFailEarlyLead) pushViolation(earlyIssue);
      else pushWarning(earlyIssue);
    }

    const owner = steps.find((s) => {
      const start = toFinite(s.compStartMs);
      const end = toFinite(s.compEndMs);
      if (start == null || end == null) return false;
      // Apply the same boundary tolerance used by inOwnWindow so that clips placed
      // within the tolerance window of their own step don't also fire cross-screen-owner
      // against the preceding step's half-open interval. Without this, a clip at
      // (windowStartMs - 80ms) passes inOwnWindow (within 120ms tolerance) but is
      // simultaneously assigned to the prior step — producing contradictory violations.
      return clipStartMs >= (start - boundaryToleranceMs) && clipStartMs < (end + boundaryToleranceMs);
    });
    if (owner && owner.stepId && owner.stepId !== stepId) {
      pushViolation({
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
    pushWarning({
      code: 'timing-older-than-manifest',
      message: 'voiceover-manifest is newer than timing-contract; validate after sync-map/audio edits.',
    });
  }

  const violationCodeCounts = {};
  const warningCodeCounts = {};
  const violationCategoryCounts = {};
  const warningCategoryCounts = {};
  for (const v of violations) {
    const code = v.code || 'unknown';
    const cat = v.category || 'other';
    violationCodeCounts[code] = (violationCodeCounts[code] || 0) + 1;
    violationCategoryCounts[cat] = (violationCategoryCounts[cat] || 0) + 1;
  }
  for (const w of warnings) {
    const code = w.code || 'unknown';
    const cat = w.category || 'other';
    warningCodeCounts[code] = (warningCodeCounts[code] || 0) + 1;
    warningCategoryCounts[cat] = (warningCategoryCounts[cat] || 0) + 1;
  }

  return {
    ok: violations.length === 0,
    checkedAt: new Date().toISOString(),
    minVisualLeadMs,
    boundaryToleranceMs,
    violations,
    warnings,
    timelineRows,
    summary: {
      violationCodeCounts,
      warningCodeCounts,
      violationCategoryCounts,
      warningCategoryCounts,
      clipRows: timelineRows.length,
    },
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

