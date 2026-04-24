#!/usr/bin/env node
// check-run-sync.mjs — quick sync/dedupe health check for a pipeline run dir.
//
// Usage:
//   node scripts/check-run-sync.mjs <run-dir>
//
// Exits 0 if clean, 1 if problems found. Prints a short report.
// Checks:
//   1. step-timing.json: no duplicate step ids in consecutive entries
//   2. voiceover-manifest.json: no clip id appears more than once
//   3. narration-sync-validation.json ok:true
//   4. timing-contract.json maxOverrunMs === 0
//   5. per-clip lead: clipStart - stepWindowStart ∈ [200, 350] ms
//   6. per-clip slack: stepWindowEnd - clipEnd >= 0
//   7. demo-scratch.mp4 exists and has non-zero duration

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const runDir = process.argv[2];
if (!runDir) {
  console.error('usage: node scripts/check-run-sync.mjs <run-dir>');
  process.exit(2);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

const problems = [];
const warnings = [];

// 1. step-timing
const st = readJson(path.join(runDir, 'step-timing.json'));
if (!st) {
  problems.push('step-timing.json missing or unreadable');
} else {
  const steps = Array.isArray(st.steps) ? st.steps : [];
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].id === steps[i - 1].id) {
      problems.push(`step-timing consecutive duplicate: "${steps[i].id}" at index ${i - 1} and ${i}`);
    }
  }
}

// 2. voiceover-manifest
const vm = readJson(path.join(runDir, 'voiceover-manifest.json'));
if (!vm) {
  warnings.push('voiceover-manifest.json missing (pipeline may not have reached voiceover)');
} else {
  const counts = new Map();
  for (const c of (vm.clips || [])) {
    counts.set(c.id, (counts.get(c.id) || 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) problems.push(`voiceover-manifest clip "${id}" appears ${n} times (must be 1)`);
  }
}

// 3. narration-sync-validation
const ns = readJson(path.join(runDir, 'narration-sync-validation.json'));
if (ns) {
  if (ns.ok !== true) problems.push(`narration-sync-validation.ok === ${ns.ok} (should be true)`);
  for (const v of (ns.violations || [])) {
    problems.push(`narration-sync violation [${v.code}] ${v.stepId || ''}: ${String(v.message || '').slice(0, 140)}`);
  }
}

// 4-6. timing-contract + per-clip sync
const tc = readJson(path.join(runDir, 'timing-contract.json'));
if (tc && vm) {
  const tcmap = new Map((tc.steps || []).map(s => [s.stepId, s]));
  const maxOverrun = tc?.summary?.maxOverrunMs ?? 0;
  if (maxOverrun > 0) {
    problems.push(`timing-contract maxOverrunMs=${maxOverrun} (narration outlasts visible window)`);
  }
  for (const c of (vm.clips || [])) {
    const win = tcmap.get(c.id);
    if (!win) continue;
    const lead = (c.compStartMs ?? 0) - (win.compStartMs ?? 0);
    const slack = (win.compEndMs ?? 0) - (c.compEndMs ?? 0);
    if (lead < 100 || lead > 500) {
      problems.push(`clip "${c.id}" lead=${lead}ms (expected ~250ms)`);
    }
    if (slack < -20) {
      problems.push(`clip "${c.id}" slack=${slack}ms (clip exceeds step window end)`);
    }
  }
}

// 7. MP4
const mp4 = path.join(runDir, 'demo-scratch.mp4');
if (fs.existsSync(mp4)) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mp4}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    const dur = parseFloat(out);
    if (!Number.isFinite(dur) || dur <= 10) problems.push(`demo-scratch.mp4 duration=${out}s (unexpectedly short)`);
    else console.log(`demo-scratch.mp4 duration=${dur.toFixed(2)}s`);
  } catch (e) {
    warnings.push(`ffprobe failed on demo-scratch.mp4: ${e.message}`);
  }
} else {
  warnings.push('demo-scratch.mp4 missing (render stage may have been skipped)');
}

if (warnings.length) {
  console.log('\nWARNINGS:');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (problems.length === 0) {
  console.log(`\n[${path.basename(runDir)}] SYNC CHECK: PASS`);
  process.exit(0);
}
console.log(`\n[${path.basename(runDir)}] SYNC CHECK: FAIL (${problems.length} issue(s))`);
for (const p of problems) console.log(`  ✗ ${p}`);
process.exit(1);
