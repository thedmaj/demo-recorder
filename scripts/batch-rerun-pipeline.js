#!/usr/bin/env node
/**
 * Batch re-run last N pipeline prompts with isolated prompt cleanup between runs.
 *
 * Usage:
 *   node scripts/batch-rerun-pipeline.js [--manifest=PATH] [--to=STAGE] [--dry-run]
 *
 * Default: inputs/batch-rerun/manifest.json, --to=record
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INPUTS_DIR = path.join(PROJECT_ROOT, 'inputs');
const SHARED_OUT = path.join(PROJECT_ROOT, 'out');
const DEFAULT_MANIFEST = path.join(INPUTS_DIR, 'batch-rerun', 'manifest.json');

function reportPathForManifest(manifestPath) {
  const base = path.basename(path.dirname(manifestPath)) || 'batch-rerun';
  return path.join(PROJECT_ROOT, 'artifacts', `${base}-report.json`);
}

const STALE_SHARED_FILES = [
  'ingested-inputs.json',
  'demo-script.json',
  'product-research.json',
  'pipeline-plan.json',
];

function parseArgs(argv) {
  const flags = { to: 'record', dryRun: false, manifest: DEFAULT_MANIFEST, startFrom: 1 };
  for (const a of argv) {
    if (a.startsWith('--manifest=')) flags.manifest = path.resolve(a.split('=')[1]);
    else if (a.startsWith('--to=')) flags.to = a.split('=')[1];
    else if (a.startsWith('--start-from=')) flags.startFrom = Math.max(1, parseInt(a.split('=')[1], 10) || 1);
    else if (a === '--dry-run') flags.dryRun = true;
  }
  return flags;
}

function cleanupSharedOut() {
  for (const name of STALE_SHARED_FILES) {
    const p = path.join(SHARED_OUT, name);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[batch] Removed stale shared out/${name}`);
    }
  }
  // Orchestrator expects out/latest to be a symlink; stale real dirs break updates.
  const latest = path.join(SHARED_OUT, 'latest');
  try {
    if (fs.existsSync(latest) && !fs.lstatSync(latest).isSymbolicLink()) {
      fs.rmSync(latest, { recursive: true, force: true });
      console.log('[batch] Removed stale out/latest (not a symlink)');
    }
  } catch (_) { /* ignore */ }
}

function cleanupInputsPrompt() {
  const promptPath = path.join(INPUTS_DIR, 'prompt.txt');
  if (fs.existsSync(promptPath)) {
    const bak = path.join(INPUTS_DIR, `prompt.batch-backup.${Date.now()}.txt`);
    fs.copyFileSync(promptPath, bak);
    fs.unlinkSync(promptPath);
    console.log(`[batch] Backed up + cleared inputs/prompt.txt → ${path.basename(bak)}`);
  }
}

function installPrompt(src, expectedCompany) {
  if (!fs.existsSync(src)) throw new Error(`Prompt not found: ${src}`);
  const content = fs.readFileSync(src, 'utf8');
  if (expectedCompany) {
    const hostLine = content.match(/\*\*Host:\*\*\s*\*\*([^*]+)\*\*/);
    const host = (hostLine?.[1] || '').toLowerCase();
    const company = String(expectedCompany).toLowerCase();
    const token = company.split(/\s+/)[0];
    if (host && token && !host.includes(token)) {
      throw new Error(
        `Prompt host "${hostLine[1]}" does not match expected company "${expectedCompany}" — aborting to prevent contamination`
      );
    }
  }
  fs.mkdirSync(INPUTS_DIR, { recursive: true });
  const dest = path.join(INPUTS_DIR, 'prompt.txt');
  fs.writeFileSync(dest, content);
  const hash = require('crypto').createHash('sha256').update(content).digest('hex');
  console.log(`[batch] Installed prompt (${hash.slice(0, 12)}…) → inputs/prompt.txt`);
  return { dest, hash, content };
}

/**
 * Find an existing run dir whose product-research.json fingerprint matches the prompt.
 * Prefers explicit resumeRunId, then sourceRunId, then newest matching dir.
 */
function findResumableRunId({ promptContent, resumeRunId, sourceRunId }) {
  const { fingerprintPrompt } = require('./scratch/utils/prompt-fingerprint');
  const fp = fingerprintPrompt(promptContent || '');
  if (!fp) return null;

  const candidates = [];
  if (resumeRunId) candidates.push(resumeRunId);
  if (sourceRunId && sourceRunId !== resumeRunId) candidates.push(sourceRunId);

  const demosDir = path.join(SHARED_OUT, 'demos');
  if (fs.existsSync(demosDir)) {
    for (const name of fs.readdirSync(demosDir).sort().reverse()) {
      if (!candidates.includes(name)) candidates.push(name);
    }
  }

  for (const runId of candidates) {
    const prPath = path.join(demosDir, runId, 'product-research.json');
    if (!fs.existsSync(prPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(prPath, 'utf8'));
      if (data.inputPromptFingerprint === fp) {
        return runId;
      }
    } catch (_) { /* skip corrupt */ }
  }
  return null;
}

function runPipeline({ promptPath, to, research, resumeRunId, sourceRunId, promptContent }) {
  const resumableRunId = findResumableRunId({
    promptContent,
    resumeRunId,
    sourceRunId,
  });

  const args = resumableRunId
    ? [
        'run', 'pipe', '--', 'resume', resumableRunId,
        '--with-slides',
        '--non-interactive',
        '--from=ingest',
        `--to=${to}`,
      ]
    : [
        'run', 'pipe', '--', 'new',
        `--prompt=${promptPath}`,
        '--with-slides',
        '--non-interactive',
        `--to=${to}`,
        `--research=${research || 'messaging'}`,
      ];

  if (resumableRunId) {
    console.log(`[batch] RESEARCH_REUSE — resuming ${resumableRunId} from ingest (fingerprint match)`);
  }
  console.log(`[batch] Executing: npm ${args.join(' ')}`);
  const res = spawnSync('npm', args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, SCRATCH_AUTO_APPROVE: 'true', RESEARCH_REUSE: 'true' },
  });
  return { exitCode: res.status ?? 1, signal: res.signal, resumableRunId };
}

function readStatusJson() {
  const res = spawnSync('npm', ['run', 'pipe', '--', 'status', '--json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  try {
    const lines = (res.stdout || '').trim().split('\n');
    const jsonLine = lines.reverse().find((l) => l.startsWith('{'));
    return jsonLine ? JSON.parse(jsonLine) : null;
  } catch {
    return null;
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(flags.manifest)) {
    console.error(`Manifest missing: ${flags.manifest}`);
    process.exit(64);
  }
  const manifest = JSON.parse(fs.readFileSync(flags.manifest, 'utf8'));
  const runs = manifest.runs || [];
  const REPORT_PATH = reportPathForManifest(flags.manifest);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_ROOT, 'artifacts'), { recursive: true });

  const report = {
    startedAt: new Date().toISOString(),
    manifest: path.relative(PROJECT_ROOT, flags.manifest),
    to: flags.to,
    startFrom: flags.startFrom,
    results: [],
  };

  console.log(`[batch] Starting ${runs.length} runs → ${flags.to} (from index ${flags.startFrom})`);

  for (let i = flags.startFrom - 1; i < runs.length; i++) {
    const entry = runs[i];
    const label = `[${i + 1}/${runs.length}] ${entry.id}`;
    console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);

    const result = {
      id: entry.id,
      sourceRunId: entry.sourceRunId,
      company: entry.company,
      website: entry.website,
      promptFile: entry.promptFile,
      startedAt: new Date().toISOString(),
      status: 'pending',
    };

    const promptPath = path.join(PROJECT_ROOT, entry.promptFile);
    if (!fs.existsSync(promptPath)) {
      result.status = 'skipped';
      result.error = `prompt missing: ${entry.promptFile}`;
      report.results.push(result);
      continue;
    }

    if (flags.dryRun) {
      result.status = 'dry-run';
      report.results.push(result);
      continue;
    }

    try {
      cleanupSharedOut();
      cleanupInputsPrompt();
      const { content: promptContent } = installPrompt(promptPath, entry.company);
      const resumeRunId = entry.resumeRunId || entry.sourceRunId || null;
      const { exitCode, signal, resumableRunId } = runPipeline({
        promptPath,
        to: flags.to,
        research: entry.research,
        resumeRunId,
        sourceRunId: entry.sourceRunId || null,
        promptContent,
      });
      result.researchSkipped = Boolean(resumableRunId);
      result.resumedFromRunId = resumableRunId || null;
      const statusJson = readStatusJson();
      result.exitCode = exitCode;
      result.signal = signal;
      result.runId = statusJson?.runId || null;
      result.firstFailed = statusJson?.firstFailed || null;
      result.lastStage = statusJson?.stages?.find((s) => s.status === 'running')?.name
        || statusJson?.stages?.filter((s) => s.status === 'completed').pop()?.name
        || null;
      result.recommendedRecovery = statusJson?.recommendedRecovery || null;

      if (exitCode === 0 && !statusJson?.firstFailed) {
        result.status = 'ok';
      } else {
        result.status = 'failed';
        result.error = statusJson?.stages?.find((s) => s.name === statusJson?.firstFailed)?.lastError
          || `exit ${exitCode}${signal ? ` signal ${signal}` : ''}`;
        console.warn(`[batch] ${label} FAILED — continuing to next run`);
      }
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
      console.warn(`[batch] ${label} ERROR: ${err.message}`);
    }

    result.finishedAt = new Date().toISOString();
    report.results.push(result);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }

  report.finishedAt = new Date().toISOString();
  const ok = report.results.filter((r) => r.status === 'ok').length;
  const failed = report.results.filter((r) => r.status === 'failed' || r.status === 'error').length;
  report.summary = { total: report.results.length, ok, failed };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[batch] Done. ok=${ok} failed=${failed} report=${REPORT_PATH}`);
  process.exit(failed > 0 ? 2 : 0);
}

main();
