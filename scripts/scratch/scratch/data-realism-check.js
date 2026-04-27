#!/usr/bin/env node
'use strict';
/**
 * data-realism-check.js
 *
 * Stage entry point. Runs between `script-critique` and `embed-script-validate`
 * to catch sample-data problems (generic placeholders, persona/balance
 * inconsistencies, round numbers, wrong masking style, fake-looking
 * transaction descriptions) BEFORE the build LLM bakes them into the host
 * app HTML.
 *
 * Reads:
 *   <runDir>/demo-script.json
 *   <runDir>/brand/<slug>.json   (preferred)
 *   <runDir>/brand-extract.json  (legacy fallback)
 *
 * Writes:
 *   <runDir>/data-realism-report.json
 *   <runDir>/data-realism-task.md   (only when there are issues — agent handoff)
 *
 * Behavior:
 *   - Run deterministic checks always.
 *   - Optionally run a Haiku-graded check on top (skipped automatically
 *     when ANTHROPIC_API_KEY is missing or DATA_REALISM_HAIKU=0). Cheap
 *     (~500 tokens). Disable with DATA_REALISM_HAIKU=0 in CI.
 *   - Returns a report. The orchestrator owns the continue-gate logic when
 *     there are critical issues + agent mode (mirrors prompt-fidelity-check).
 *
 * Env vars:
 *   PIPELINE_RUN_DIR            — read fresh inside main() per run
 *   ANTHROPIC_API_KEY           — optional (enables Haiku grader)
 *   DATA_REALISM_HAIKU          — set to "0" to disable the Haiku grader
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
function resolveOutDir() {
  return process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
}

const {
  runDeterministicChecks,
  gradeWithHaiku,
  buildDataRealismFixTask,
} = require('../utils/data-realism');

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function readBrandProfile(runDir) {
  // Prefer artifacts/brand/<slug>.json (canonical); fall back to legacy
  // brand-extract.json at the run root.
  const brandDir = path.join(runDir, 'artifacts', 'brand');
  if (fs.existsSync(brandDir)) {
    try {
      for (const f of fs.readdirSync(brandDir)) {
        if (f.endsWith('.json') && !/brand-extract\.json$/.test(f)) {
          const j = safeReadJson(path.join(brandDir, f));
          if (j && (j.name || j.slug || j.colors)) return j;
        }
      }
    } catch (_) {}
  }
  return safeReadJson(path.join(runDir, 'brand-extract.json'));
}

function emitPipeEvent(event, payload) {
  console.log(`::PIPE::${JSON.stringify({ event, at: new Date().toISOString(), ...payload })}`);
}

function isAgentMode() {
  const explicit = String(process.env.PIPE_AGENT_MODE ?? '').trim().toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no' || explicit === 'off') return false;
  if (explicit === '1' || explicit === 'true' || explicit === 'yes' || explicit === 'on') return true;
  if (process.env.CLAUDECODE === '1') return true;
  if (process.env.CLAUDE_CODE_VERSION) return true;
  if (process.env.CURSOR_AGENT_MODE === '1') return true;
  if (process.env.CURSOR_TRACE_ID) return true;
  return false;
}

async function main() {
  const runDir = resolveOutDir();
  const scriptFile = path.join(runDir, 'demo-script.json');
  if (!fs.existsSync(scriptFile)) {
    console.log('[data-realism-check] No demo-script.json found — skipping.');
    return { passed: true, skipped: true, reason: 'no-demo-script' };
  }
  const demoScript = safeReadJson(scriptFile);
  if (!demoScript) {
    console.warn('[data-realism-check] demo-script.json could not be parsed — skipping.');
    return { passed: true, skipped: true, reason: 'parse-error' };
  }
  const brandProfile = readBrandProfile(runDir);
  const runId = path.basename(runDir);

  console.log(
    `[data-realism-check] checking ${(demoScript.steps || []).length} step(s) ` +
    (brandProfile ? `against brand "${brandProfile.name || brandProfile.slug || 'unknown'}"` : '(no brand profile)')
  );

  const deterministic = runDeterministicChecks(demoScript, brandProfile);
  for (const i of deterministic.issues) {
    const tag = i.severity === 'critical' ? '[CRITICAL]' : '[WARN    ]';
    console.warn(`  ${tag} ${i.kind} — ${i.evidence}`);
  }

  // Optional Haiku grader. Skipped when DATA_REALISM_HAIKU=0 or no API key.
  let llm = { issues: [], skipped: true, reason: 'disabled' };
  const haikuEnabled = String(process.env.DATA_REALISM_HAIKU ?? '1').trim() !== '0';
  if (haikuEnabled && process.env.ANTHROPIC_API_KEY) {
    console.log('[data-realism-check] running Haiku grader…');
    try {
      llm = await gradeWithHaiku(demoScript, brandProfile);
      if (llm.issues && llm.issues.length > 0) {
        for (const i of llm.issues) {
          const tag = i.severity === 'critical' ? '[CRITICAL]' : '[WARN    ]';
          console.warn(`  ${tag} ${i.kind} — ${i.evidence}`);
        }
      }
    } catch (err) {
      console.warn(`[data-realism-check] Haiku grader failed: ${err.message}`);
      llm = { issues: [], skipped: true, reason: `error: ${err.message}` };
    }
  } else if (!haikuEnabled) {
    llm = { issues: [], skipped: true, reason: 'DATA_REALISM_HAIKU=0' };
  } else if (!process.env.ANTHROPIC_API_KEY) {
    llm = { issues: [], skipped: true, reason: 'no-anthropic-key' };
  }

  const allIssues = [...deterministic.issues, ...((llm && llm.issues) || [])];
  const criticalCount = allIssues.filter(i => i.severity === 'critical').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const passed = criticalCount === 0;

  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    brand: brandProfile ? (brandProfile.name || brandProfile.slug || null) : null,
    deterministic: {
      issueCount: deterministic.issues.length,
      criticalCount: deterministic.criticalCount,
      warningCount: deterministic.warningCount,
    },
    llm: {
      skipped: !!llm.skipped,
      reason: llm.skipped ? llm.reason : null,
      model: llm.model || null,
      issueCount: (llm.issues || []).length,
    },
    issues: allIssues,
    criticalCount,
    warningCount,
    passed,
  };
  fs.writeFileSync(path.join(runDir, 'data-realism-report.json'), JSON.stringify(report, null, 2));
  console.log(
    `[data-realism-check] report → data-realism-report.json ` +
    `(${criticalCount} critical, ${warningCount} warning)`
  );

  let taskPath = null;
  if (allIssues.length > 0) {
    const orchestratorDriven = isAgentMode() && criticalCount > 0;
    const md = buildDataRealismFixTask({
      runId, deterministic, llm,
      opts: { orchestratorDriven },
    });
    taskPath = path.join(runDir, 'data-realism-task.md');
    fs.writeFileSync(taskPath, md, 'utf8');
    console.log(`[data-realism-check] task md → data-realism-task.md`);
  }

  emitPipeEvent('data_realism_check_done', {
    runId,
    passed,
    criticalCount,
    warningCount,
    haikuEnabled: !llm.skipped,
    taskPath: taskPath ? path.relative(runDir, taskPath) : null,
  });

  return { ...report, comparison: { passed, criticalCount, warningCount } };
}

if (require.main === module) {
  main().catch(err => {
    console.error('[data-realism-check] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
