'use strict';
/**
 * pipeline-handoff.js
 *
 * Orchestrator → agent handoff at named checkpoints. Lets the running
 * pipeline pause for a Claude Code (or Cursor) agent supervisor to
 * read a context bundle, ask the user for a decision via the agent's
 * normal question UI, and write a recovery plan that the pipeline
 * picks up to resume.
 *
 * Layout per checkpoint, all inside the run directory:
 *
 *   handoffs/
 *     <checkpoint>.md            human-readable summary the agent shows
 *     <checkpoint>.options.json  structured options the agent picks from
 *     handoff-pending            sentinel: "agent action required"
 *     recovery-plan.json         the agent writes this; pipeline reads + clears
 *     <checkpoint>.resolved.json archived plan after pipeline consumes it
 *
 * Public API:
 *   pauseForHandoff({ runDir, checkpoint, summaryMarkdown, options,
 *                     timeoutMs, pollIntervalMs })
 *     → returns the parsed recovery plan: { action, args, instructions?, ... }
 *
 * Bypass paths (in priority order — first one that matches wins):
 *   1. PIPE_NO_HANDOFF=true        — agent handoffs disabled entirely
 *   2. PIPE_AGENT_HANDOFF !== true — opt-in required even when
 *                                    SCRATCH_AUTO_APPROVE is on
 *   3. Headless CI fallback        — when neither flag is set and the
 *                                    process has no TTY, auto-resume
 *                                    after `bypassWarnAfterMs` (default
 *                                    2 min) with the recommended
 *                                    option's action
 *
 * The agent-side counterpart is `.claude/skills/pipe-handoff/SKILL.md`
 * which exposes a `/pipe-handoff` slash command. The skill finds the
 * pending sentinel, renders the markdown, calls AskUserQuestion with
 * the option list, and writes recovery-plan.json with the user's pick.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_POLL_MS = 3000;
const HEADLESS_BYPASS_WARN_MS = 2 * 60 * 1000;

function isHandoffEnabled() {
  if (process.env.PIPE_NO_HANDOFF === 'true') return false;
  if (process.env.PIPE_AGENT_HANDOFF === 'true') return true;
  return false;
}

function handoffDir(runDir) {
  const dir = path.join(runDir, 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sentinelPath(runDir) {
  return path.join(handoffDir(runDir), 'handoff-pending');
}

function recoveryPlanPath(runDir) {
  return path.join(handoffDir(runDir), 'recovery-plan.json');
}

function emit(line) {
  // Re-use the orchestrator's PIPE event channel so the same monitor that
  // tracks heartbeats sees handoff lifecycle.
  console.log(line);
}

function archivePending(runDir, checkpoint, plan) {
  try {
    const archive = path.join(handoffDir(runDir), `${checkpoint}.resolved.json`);
    fs.writeFileSync(archive, JSON.stringify({
      checkpoint,
      resolvedAt: new Date().toISOString(),
      plan,
    }, null, 2), 'utf8');
  } catch (_) {}
}

function writeBundle(runDir, checkpoint, summaryMarkdown, options) {
  const dir = handoffDir(runDir);
  fs.writeFileSync(path.join(dir, `${checkpoint}.md`), summaryMarkdown, 'utf8');
  fs.writeFileSync(path.join(dir, `${checkpoint}.options.json`),
    JSON.stringify({
      checkpoint,
      writtenAt: new Date().toISOString(),
      runDir,
      runId: path.basename(runDir),
      options,
    }, null, 2),
    'utf8');
  fs.writeFileSync(sentinelPath(runDir), JSON.stringify({
    checkpoint,
    writtenAt: new Date().toISOString(),
  }, null, 2), 'utf8');
}

function consumePlan(runDir, checkpoint) {
  const planPath = recoveryPlanPath(runDir);
  if (!fs.existsSync(planPath)) return null;
  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    const plan = JSON.parse(raw);
    archivePending(runDir, checkpoint, plan);
    fs.unlinkSync(planPath);
    try { fs.unlinkSync(sentinelPath(runDir)); } catch (_) {}
    return plan;
  } catch (err) {
    emit(`[handoff] Could not parse recovery-plan.json: ${err.message}`);
    return null;
  }
}

/**
 * Block the pipeline until the agent writes recovery-plan.json (or the
 * configured timeout fires). When agent handoffs are disabled, returns
 * `{ action: 'continue', source: 'bypass' }` immediately so headless
 * CI runs keep working without code branches at every caller.
 */
async function pauseForHandoff({
  runDir,
  checkpoint,
  summaryMarkdown,
  options,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_MS,
  bypassWarnAfterMs = HEADLESS_BYPASS_WARN_MS,
}) {
  if (!isHandoffEnabled()) {
    return { action: 'continue', source: 'bypass:disabled' };
  }
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('[handoff] options[] is required and must be non-empty');
  }
  if (!summaryMarkdown || typeof summaryMarkdown !== 'string') {
    throw new Error('[handoff] summaryMarkdown is required');
  }

  writeBundle(runDir, checkpoint, summaryMarkdown, options);
  emit(`::PIPE:: event=handoff_pending  checkpoint=${checkpoint}  runDir=${runDir}  at=${new Date().toISOString()}`);
  emit(`[handoff] Pipeline paused — write a recovery plan via the agent's /pipe-handoff slash command.`);
  emit(`[handoff]   Run:        ${path.basename(runDir)}`);
  emit(`[handoff]   Checkpoint: ${checkpoint}`);
  emit(`[handoff]   Summary:    ${path.join(runDir, 'handoffs', checkpoint + '.md')}`);
  emit(`[handoff]   Options:    ${path.join(runDir, 'handoffs', checkpoint + '.options.json')}`);

  const startMs = Date.now();
  let lastBypassWarning = 0;
  while (Date.now() - startMs < timeoutMs) {
    const plan = consumePlan(runDir, checkpoint);
    if (plan) {
      emit(`::PIPE:: event=handoff_resolved  checkpoint=${checkpoint}  action=${plan.action || 'unknown'}  at=${new Date().toISOString()}`);
      return { ...plan, source: 'agent' };
    }
    // Headless-friendly nudge — if no TTY, periodically remind the operator
    // they can also resolve by writing the file manually.
    if (!process.stdout.isTTY && Date.now() - startMs > bypassWarnAfterMs && Date.now() - lastBypassWarning > bypassWarnAfterMs) {
      lastBypassWarning = Date.now();
      emit(`[handoff] Still waiting on recovery-plan.json at ${recoveryPlanPath(runDir)}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  emit(`::PIPE:: event=handoff_timeout  checkpoint=${checkpoint}  timeoutMs=${timeoutMs}`);
  // On timeout: bail to the recommended option's action if one is marked
  // recommended; otherwise abort. Either way, the handoff bundle stays
  // on disk for post-mortem.
  const recommended = options.find((o) => o.recommended === true) || options[0];
  return {
    action: recommended.action,
    args: recommended.args || {},
    source: 'timeout',
    note: `Handoff timed out after ${timeoutMs}ms; defaulting to "${recommended.action}".`,
  };
}

module.exports = {
  pauseForHandoff,
  isHandoffEnabled,
  // exposed for tests
  _internal: { writeBundle, consumePlan, handoffDir, sentinelPath, recoveryPlanPath },
};
