#!/usr/bin/env node
'use strict';
/**
 * prompt-fidelity-check.js
 *
 * Stage entry point. Runs between `script` and `script-critique` to catch
 * drift between the user's `inputs/prompt.txt` and the LLM-generated
 * `demo-script.json` BEFORE the build LLM commits to a wrong demo.
 *
 * Reads:
 *   <runDir>/inputs/prompt.txt    (preferred: archived per-run copy)
 *   <runDir>/prompt.txt           (legacy fallback)
 *   inputs/prompt.txt             (last-resort fallback for early runs)
 *   <runDir>/demo-script.json
 *
 * Writes:
 *   <runDir>/prompt-fidelity-report.json   (machine-readable result)
 *   <runDir>/prompt-fidelity-task.md       (only on critical drift; agent handoff)
 *
 * Behavior:
 *   - No drift                                    → log, write report, return passed=true.
 *   - Critical drift + agent mode                 → write task .md, return passed=false
 *                                                   so the orchestrator (which knows about
 *                                                   agent context + continue-gates) can
 *                                                   pause. This module never blocks itself —
 *                                                   it returns a structured result and lets
 *                                                   the orchestrator decide.
 *   - Critical drift + no agent / SCRATCH_AUTO_APPROVE=true
 *                                                 → log a clear warning summary, write
 *                                                   report+task md (so user can read it),
 *                                                   but do NOT block.
 *
 * Stage status code:
 *   - returns 0 always (failure modes return a structured passed=false report
 *     instead of throwing, so the pipeline keeps running unless the orchestrator
 *     pauses on a continue-gate). Throws only on unrecoverable errors (no
 *     prompt.txt, no demo-script.json, etc.).
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
// NOTE: read PIPELINE_RUN_DIR fresh inside main() rather than capturing it at
// module-load time. The orchestrator sets it per-run via the child env, and
// unit tests need to override it per-test.
function resolveOutDir() {
  return process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
}

const {
  extractPromptEntities,
  detectStoryboardTier,
  compareEntitiesToScript,
  buildFidelityFixTask,
} = require('../utils/prompt-fidelity');

function readPromptText(runDir) {
  const candidates = [
    path.join(runDir, 'inputs', 'prompt.txt'),
    path.join(runDir, 'prompt.txt'),
    path.join(PROJECT_ROOT, 'inputs', 'prompt.txt'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { path: candidate, text: fs.readFileSync(candidate, 'utf8') };
      }
    } catch (_) {}
  }
  return null;
}

function readDemoScript(runDir) {
  const file = path.join(runDir, 'demo-script.json');
  if (!fs.existsSync(file)) return null;
  try {
    return { path: file, script: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    throw new Error(`prompt-fidelity-check: demo-script.json is invalid JSON: ${err.message}`);
  }
}

/**
 * Pipe-emit shim. The orchestrator emits structured `::PIPE::<event>` lines
 * for downstream tools (dashboard, Claude Code). This stage uses the same
 * lightweight format so it's discoverable in the same log stream.
 */
function emitPipeEvent(event, payload) {
  const line = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
  console.log(`::PIPE::${line}`);
}

function isAgentMode() {
  // Mirror the routing logic in scripts/scratch/orchestrator.js#isAgentContext
  // but kept inline here so this stage script can run standalone too.
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
  const prompt = readPromptText(runDir);
  if (!prompt) {
    console.warn('[prompt-fidelity-check] No prompt.txt found anywhere — skipping.');
    return { passed: true, skipped: true, reason: 'no-prompt-txt' };
  }
  const demo = readDemoScript(runDir);
  if (!demo) {
    console.warn('[prompt-fidelity-check] No demo-script.json found — script stage may have failed; skipping.');
    return { passed: true, skipped: true, reason: 'no-demo-script' };
  }

  console.log(`[prompt-fidelity-check] reading prompt from ${path.relative(runDir, prompt.path)}`);
  console.log(`[prompt-fidelity-check] reading script from ${path.relative(runDir, demo.path)}`);

  const entities = extractPromptEntities(prompt.text);
  const storyboardTier = detectStoryboardTier(prompt.text, { entities });
  const comparison = compareEntitiesToScript(entities, demo.script);

  const runId = path.basename(runDir);
  const agent = isAgentMode();
  const report = {
    generatedAt: new Date().toISOString(),
    runId,
    promptPath: path.relative(runDir, prompt.path),
    scriptPath: path.relative(runDir, demo.path),
    entities,
    storyboardTier: {
      tier: storyboardTier.tier,
      signals: storyboardTier.signals,
      beatCount: storyboardTier.beatList.length,
    },
    comparison,
    agentMode: agent,
  };

  const reportPath = path.join(runDir, 'prompt-fidelity-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[prompt-fidelity-check] report → ${path.relative(runDir, reportPath)}`);

  console.log(
    `[prompt-fidelity-check] storyboard tier: ${storyboardTier.tier} ` +
    `(${storyboardTier.signals.join(', ') || '—'})`
  );
  console.log(
    `[prompt-fidelity-check] fidelity score: ${comparison.score}/100 ` +
    `(${comparison.criticalCount} critical, ${comparison.warningCount} warning)`
  );

  if (comparison.drifts.length > 0) {
    for (const d of comparison.drifts) {
      const tag = d.severity === 'critical' ? '[CRITICAL]' : '[WARN    ]';
      console.warn(`  ${tag} ${d.kind} — ${d.field}: expected=${JSON.stringify(d.expected)} actual=${JSON.stringify(d.actual)}`);
    }
  }

  // Always write the task .md when there's any drift — keeps it readable for
  // humans even when not in agent mode. Set `orchestratorDriven` only when we
  // actually expect the orchestrator to gate on this.
  let taskPath = null;
  if (comparison.drifts.length > 0) {
    const orchestratorDriven = agent && comparison.criticalCount > 0;
    const md = buildFidelityFixTask({
      runId,
      entities,
      comparison,
      storyboardTier,
      opts: { orchestratorDriven },
    });
    taskPath = path.join(runDir, 'prompt-fidelity-task.md');
    fs.writeFileSync(taskPath, md, 'utf8');
    console.log(`[prompt-fidelity-check] task md → ${path.relative(runDir, taskPath)}`);
  }

  emitPipeEvent('prompt_fidelity_check_done', {
    runId,
    passed: comparison.passed,
    score: comparison.score,
    criticalCount: comparison.criticalCount,
    warningCount: comparison.warningCount,
    storyboardTier: storyboardTier.tier,
    taskPath: taskPath ? path.relative(runDir, taskPath) : null,
    agentMode: agent,
  });

  if (!comparison.passed && agent) {
    console.warn('[prompt-fidelity-check] critical drift + agent mode — orchestrator will pause for agent fix.');
  } else if (!comparison.passed) {
    console.warn('[prompt-fidelity-check] critical drift detected (non-blocking — set PIPE_AGENT_MODE=1 to gate).');
  } else {
    console.log('[prompt-fidelity-check] all critical entities aligned.');
  }

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[prompt-fidelity-check] Fatal error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
