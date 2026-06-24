'use strict';
/**
 * plaid-link-integrity.js
 *
 * HARD GATE + QA checks guaranteeing the live Plaid Link / Layer / IDV modal is
 * actually RECORDED (visible on screen), is not CLIPPED out by the post-process
 * cut, and is PRESENT in the final rendered video.
 *
 * WHY: 2026-06-18 — the Cox Automotive app-only render shipped with NO Plaid
 * Link screens. The launch step recorded host UI only (the modal never
 * composited into the video); the post-record QA DID detect it (score 35,
 * category `plaid-modal-missing`) but the finding was deliberately
 * non-critical, so the pipeline post-processed (cutting 80s of the host-only
 * launch window) and rendered a Plaid-less demo. These gates make a missing /
 * clipped Plaid modal a hard failure instead of a silent warning.
 *
 * Three layered checks (callable per phase):
 *   - recording  (after `qa`, before post-process): the launch step's QA carries
 *     category `plaid-modal-missing` → the modal didn't render on screen.
 *   - clipping   (after `post-process`): the launch step retained < floor seconds
 *     of footage in the processed cut (markers too sparse → modal cut away).
 *   - final-video (after `render`): vision check on frames sampled from the final
 *     video's launch window confirms a Plaid modal is on screen.
 *
 * Gating (strict by default — set PLAID_LINK_STRICT=false to downgrade to warn):
 *   recording/clipping violations are CRITICAL; the orchestrator halts before
 *   render rather than ship a Plaid-less video.
 *
 * No network in the deterministic checks. The final-video vision check needs
 * ffmpeg + ANTHROPIC_API_KEY and degrades to a skip (pass) when unavailable.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** Minimum seconds of launch-step footage that must survive the post-process cut. */
const MIN_KEEP_S = parseFloat(process.env.PLAID_LINK_MIN_KEEP_S || '4');
/** Vision frames to sample across the final-video launch window. */
const FINAL_FRAMES = parseInt(process.env.PLAID_LINK_FINAL_FRAMES || '4', 10);

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function isStrict() {
  const v = String(process.env.PLAID_LINK_STRICT == null ? 'true' : process.env.PLAID_LINK_STRICT).toLowerCase();
  return v !== 'false' && v !== '0';
}

/** Launch steps = plaidPhase:"launch" (or id matching *-launch for link/layer/idv). */
function launchStepIds(demoScript) {
  return (demoScript.steps || [])
    .filter(s => s && (String(s.plaidPhase || '').toLowerCase() === 'launch'
      || /(?:link|layer|idv)[-_]?launch/i.test(String(s.id || ''))))
    .map(s => s.id);
}

function latestQaReport(runDir) {
  let files = [];
  try { files = fs.readdirSync(runDir).filter(f => /^qa-report-\d+\.json$/.test(f)); } catch (_) {}
  if (files.length) {
    files.sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    return readJson(path.join(runDir, files[files.length - 1]));
  }
  return readJson(path.join(runDir, 'qa-report.json'));
}

/** Raw [start,end] seconds for a step from step-timing.json. */
function rawWindowS(stepTiming, stepId) {
  const arr = Array.isArray(stepTiming) ? stepTiming : (stepTiming && stepTiming.steps) || [];
  const s = arr.find(x => (x.id || x.stepId) === stepId);
  if (!s) return null;
  const start = s.startMs != null ? s.startMs / 1000 : (s.startS != null ? s.startS : null);
  const end = s.endMs != null ? s.endMs / 1000 : (s.endS != null ? s.endS : null);
  return (start != null && end != null && isFinite(start) && isFinite(end)) ? { start, end } : null;
}

/** Seconds of processed keepRanges that overlap a raw window. */
function keptSecondsOverlapping(processed, win) {
  const ranges = (processed && processed.keepRanges) || [];
  let sum = 0;
  for (const r of ranges) {
    const a = Math.max(win.start, r.rawStart);
    const b = Math.min(win.end, r.rawEnd);
    if (b > a) sum += (b - a);
  }
  return sum;
}

/** Deterministic recording + clipping checks. */
function checkRecordingAndClip(runDir) {
  const demoScript = readJson(path.join(runDir, 'demo-script.json')) || {};
  const launches = launchStepIds(demoScript);
  const violations = [];
  if (!launches.length) return { ok: true, skipped: true, reason: 'no-launch-steps', launches: [], violations };

  const qa = latestQaReport(runDir);
  const stepTiming = readJson(path.join(runDir, 'step-timing.json'));
  const processed = readJson(path.join(runDir, 'processed-step-timing.json'));

  // Unsuccessful link: the recorder force-completed without the app's onSuccess
  // ever firing (e.g. a rejected sandbox OTP — YNAB 2026-06-24). The demo would
  // show a Link flow that never actually connected. Recorded in plaid-link-outcome.json.
  const outcome = readJson(path.join(runDir, 'plaid-link-outcome.json'));
  if (outcome && (outcome.outcome === 'forced-no-success' || outcome.outcome === 'timeout')) {
    violations.push({
      stepId: launches[0], kind: 'link-unsuccessful', severity: 'CRITICAL',
      outcome: outcome.outcome,
      detail: outcome.outcome === 'timeout'
        ? 'Plaid Link never completed (timeout) — no onSuccess; the recorded flow did not connect a bank.'
        : 'Plaid Link force-completed but onSuccess never fired — the link was NOT successful (commonly a rejected OTP). Check plaidSandboxConfig.otp / sandbox credentials and re-record.',
    });
  }

  for (const id of launches) {
    // recording: modal-missing (post-record QA category)
    const qstep = qa && (qa.steps || []).find(s => s.stepId === id);
    if (qstep && (qstep.categories || []).includes('plaid-modal-missing')) {
      violations.push({
        stepId: id, kind: 'modal-missing', severity: 'CRITICAL', score: qstep.score,
        detail: (qstep.issues || [])[0] || 'Plaid modal not visible in the recording (host UI only).',
      });
    }
    // clipping: kept-seconds floor in the processed cut
    if (stepTiming && processed) {
      const win = rawWindowS(stepTiming, id);
      if (win) {
        const kept = keptSecondsOverlapping(processed, win);
        if (kept < MIN_KEEP_S) {
          violations.push({
            stepId: id, kind: 'clipped', severity: 'CRITICAL', keptS: Number(kept.toFixed(2)),
            detail: `Plaid launch step retained only ${kept.toFixed(1)}s of footage in the processed cut (< ${MIN_KEEP_S}s floor) — the modal was clipped away.`,
          });
        }
      }
    }
  }
  return { ok: violations.length === 0, launches, violations };
}

// ── Final-video vision check ─────────────────────────────────────────────────

function ffmpegBin() { return process.env.FFMPEG_PATH || 'ffmpeg'; }

/** Map each launch step to its [startS,endS] in the FINAL video via remotion-props.json. */
function finalVideoLaunchWindows(runDir, launches) {
  const props = readJson(path.join(runDir, 'remotion-props.json'));
  if (!props) return [];
  const fps = props.fps || props.scratchFps || 30;
  const steps = props.scratchSteps || props.stepTiming || props.STEP_TIMING || props.steps || [];
  const out = [];
  for (const id of launches) {
    const s = steps.find(x => (x.id || x.stepId) === id);
    if (!s) continue;
    let startS = null, endS = null;
    if (s.startMs != null && s.endMs != null) { startS = s.startMs / 1000; endS = s.endMs / 1000; }
    else if (s.startFrame != null && s.endFrame != null) { startS = s.startFrame / fps; endS = s.endFrame / fps; }
    if (startS != null && endS != null && endS > startS) out.push({ stepId: id, startS, endS });
  }
  return out;
}

async function verifyFinalVideo(runDir, opts = {}) {
  const demoScript = readJson(path.join(runDir, 'demo-script.json')) || {};
  const launches = launchStepIds(demoScript);
  if (!launches.length) return { ok: true, skipped: true, reason: 'no-launch-steps', violations: [] };
  const video = path.join(runDir, 'demo-scratch.mp4');
  if (!fs.existsSync(video)) return { ok: true, skipped: true, reason: 'no-final-video', violations: [] };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: true, skipped: true, reason: 'no-anthropic-key', violations: [] };

  const windows = finalVideoLaunchWindows(runDir, launches);
  if (!windows.length) return { ok: true, skipped: true, reason: 'no-final-timing', violations: [] };

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
  catch (_) { return { ok: true, skipped: true, reason: 'no-anthropic-sdk', violations: [] }; }
  const client = new Anthropic();
  const tmpDir = path.join(runDir, 'artifacts', 'plaid-link-verify');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}

  const violations = [];
  for (const w of windows) {
    const span = Math.max(0.5, w.endS - w.startS);
    const stamps = [];
    for (let i = 1; i <= FINAL_FRAMES; i++) stamps.push(w.startS + (span * i) / (FINAL_FRAMES + 1));
    const imgs = [];
    for (let i = 0; i < stamps.length; i++) {
      const out = path.join(tmpDir, `${w.stepId}-${i}.png`);
      try {
        execFileSync(ffmpegBin(), ['-nostdin', '-loglevel', 'error', '-ss', String(stamps[i].toFixed(2)),
          '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', out, '-y'], { stdio: 'ignore' });
        if (fs.existsSync(out)) imgs.push(fs.readFileSync(out).toString('base64'));
      } catch (_) {}
    }
    if (!imgs.length) { continue; } // can't sample → don't fail
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: [
          { type: 'text', text:
            'These frames are sampled from the Plaid Link launch segment of a finished demo video. ' +
            'A Plaid modal is a centered overlay/sheet (often Plaid-branded) showing a bank/institution ' +
            'list, login, OTP, or account selection. Is a Plaid modal visibly present in AT LEAST ONE frame? ' +
            'Return STRICT JSON only: {"modalPresent": true|false, "evidence": "<=120 chars"}' },
          ...imgs.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } })),
        ] }],
      });
      const raw = (resp.content || []).map(b => b.text || '').join('').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (parsed && parsed.modalPresent === false) {
        violations.push({ stepId: w.stepId, kind: 'final-video-no-modal', severity: 'CRITICAL',
          detail: `No Plaid modal visible in the final video's launch window [${w.startS.toFixed(1)}-${w.endS.toFixed(1)}s]: ${String(parsed.evidence || '').slice(0, 120)}` });
      }
    } catch (_) { /* vision error → don't fail */ }
  }
  return { ok: violations.length === 0, launches, windows, violations };
}

/** Dispatch + write report. phase: 'post-record' | 'post-process' | 'final-video'. */
async function checkPlaidLinkIntegrity(runDir, { phase = 'post-record' } = {}) {
  let res;
  if (phase === 'final-video') res = await verifyFinalVideo(runDir);
  else res = checkRecordingAndClip(runDir); // post-record + post-process both deterministic
  const report = {
    generatedAt: new Date().toISOString(), phase, strict: isStrict(),
    minKeepS: MIN_KEEP_S, ...res,
  };
  try {
    const p = path.join(runDir, 'plaid-link-integrity.json');
    const prev = readJson(p) || { phases: {} };
    prev.phases = prev.phases || {};
    prev.phases[phase] = report;
    prev.ok = (prev.ok !== false) && (res.ok !== false);
    prev.updatedAt = report.generatedAt;
    fs.writeFileSync(p, JSON.stringify(prev, null, 2), 'utf8');
  } catch (_) {}
  return report;
}

module.exports = {
  checkPlaidLinkIntegrity,
  checkRecordingAndClip,
  verifyFinalVideo,
  launchStepIds,
  isStrict,
};
