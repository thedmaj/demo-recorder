'use strict';
/**
 * post-process-recording.js
 *
 * Cuts still/waiting frames from a Plaid Link recording by defining explicit
 * KEEP ranges from step-timing.json. Everything outside the keep ranges is
 * hard-cut (removed entirely). No speed-up — only clean cuts.
 *
 * Keep ranges (derived from step timing):
 *   1. App start → phone Continue click         (app loading + phone screen)
 *   2. OTP screen appears → OTP digits filled   (OTP entry visible)
 *   3. Institution list → Confirm clicked        (bank select + account + confirm)
 *   4. Success screen (brief)                    (token exchange result)
 *
 * Result is a tight ~25-30s demo clip with hard cuts between the slow sections.
 *
 * Usage:
 *   node scripts/post-process-recording.js [options]
 *
 * Options:
 *   --input  path      Input webm  (default: out/plaid-link-test/recording.webm)
 *   --output path      Output webm (default: out/plaid-link-test/recording-processed.webm)
 *   --timing path      step-timing.json (default: out/plaid-link-test/step-timing.json)
 *   --otp-keep N       Seconds of OTP screen to keep after detection  (default: 2.5)
 *   --success-keep N   Seconds of success screen to keep              (default: 4.0)
 *   --phone-tail N     Seconds after phone-submitted to include       (default: 0.5)
 *   --max-institution N  Hard cap on institution list section in output (default: 5.0)
 *                        Section is split (list-appear | account+confirm) to fit within N seconds.
 *                        Must be ≥ 4.7s so each sub-part gets MIN_PLAID_SCREEN_MS (2s) minimum.
 *   --dry-run          Print ffmpeg command without executing
 *   --preview          Open result in default player after processing
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const isDryRun  = args.includes('--dry-run');
const isPreview = args.includes('--preview');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR      = path.join(PROJECT_ROOT, 'out', 'plaid-link-test');

const INPUT_PATH  = getArg('--input',  path.join(OUT_DIR, 'recording.webm'));
const OUTPUT_PATH = getArg('--output', path.join(OUT_DIR, 'recording-processed.webm'));
const TIMING_PATH = getArg('--timing', path.join(OUT_DIR, 'step-timing.json'));

// Tunable keep windows (seconds)
const OTP_KEEP     = parseFloat(getArg('--otp-keep',       '2.5'));
const SUCCESS_KEEP = parseFloat(getArg('--success-keep',   '4.0'));
const PHONE_TAIL   = parseFloat(getArg('--phone-tail',     '0.5'));
// Institution list hard cap: entire list→confirm section must fit within this many seconds.
// Must be ≥ 2×MIN_PLAID_SCREEN_S + LEAD_IN + TAIL = 2+2+0.2+0.5 = 4.7s.
// Default raised to 5.0s so each of the two sub-parts (list-appear, account+confirm)
// gets at least MIN_PLAID_SCREEN_S seconds of visible screen time.
const MAX_INST_S   = parseFloat(getArg('--max-institution', '5.0'));

// Minimum processed-video duration per Plaid Link sub-step screen (milliseconds).
// Screens shorter than this get a freezeMs tag; orchestrator injects a Remotion freeze.
// Phantom windows (< MIN_EMIT_MS) are transitions, not real screens — don't emit them.
const MIN_PLAID_SCREEN_MS = 2000;
const MIN_EMIT_MS         = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\n[PostProcess] ERROR: ${msg}\n`);
  process.exit(1);
}

function checkFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
  if (r.status !== 0) die('ffmpeg not found. Install with: brew install ffmpeg');
}

function getVideoDuration(filePath) {
  const r = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
  ], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) die(`ffprobe failed on ${filePath}`);
  return parseFloat(JSON.parse(r.stdout).format.duration);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Read inputs ───────────────────────────────────────────────────────────────

if (!fs.existsSync(INPUT_PATH))  die(`Input not found: ${INPUT_PATH}`);
if (!fs.existsSync(TIMING_PATH)) {
  die(`Timing file not found: ${TIMING_PATH}\nRun test-plaid-link-record.js first to generate step-timing.json`);
}

// Support two timing formats:
//   Test format:     Array<{ step, recordingOffsetS }>  — written by test-plaid-link-record.js
//   Pipeline format: { steps: [...] }                  — written by record-local.js (pipeline)
//                    Alongside this, record-local.js writes plaid-link-timing.json with the
//                    granular Plaid phase timestamps needed by this script.
const timingRaw = JSON.parse(fs.readFileSync(TIMING_PATH, 'utf8'));
let timings;
if (Array.isArray(timingRaw)) {
  // Test harness format — use directly
  timings = timingRaw;
} else {
  // Pipeline format — look for plaid-link-timing.json in same directory
  const plaidTimingPath = path.join(path.dirname(TIMING_PATH), 'plaid-link-timing.json');
  if (fs.existsSync(plaidTimingPath)) {
    timings = JSON.parse(fs.readFileSync(plaidTimingPath, 'utf8'));
    console.log(`[PostProcess] Loaded granular Plaid phase timing from: ${plaidTimingPath}`);
  } else {
    console.warn('[PostProcess] Pipeline step-timing.json detected but plaid-link-timing.json not found.');
    console.warn('[PostProcess] Run record-local.js to generate plaid-link-timing.json.');
    console.warn('[PostProcess] Proceeding with empty timing — output will be the full uncut recording.');
    timings = [];
  }
}
const T = {};  // shorthand: T['step-name'] = recordingOffsetS
for (const t of timings) T[t.step] = t.recordingOffsetS;

// ── Step-timing key schema validation ─────────────────────────────────────────
//
// These keys are written by record-local.js's recordStep() calls. If a key is
// absent (e.g. because record-local.js renamed a step), the corresponding keep
// range will be silently skipped, removing that section from the processed video.
// We warn explicitly per missing key so the problem is visible in logs.
//
// Keys are optional per flow type — phone/OTP keys only appear in Remember Me flows,
// institution keys only appear in standard flows. Warn but don't halt.
const STEP_TIMING_SCHEMA = [
  { key: 'phone-submitted',       description: 'phone Continue click (Remember Me flow)',   optional: true },
  { key: 'otp-screen',            description: 'OTP screen appeared',                       optional: true },
  { key: 'otp-filled',            description: 'OTP digits filled (post-fill pause)',        optional: true },
  { key: 'institution-list-shown',description: 'institution list appeared',                  optional: true },
  { key: 'confirm-clicked',       description: 'account confirmation clicked',               optional: true },
  { key: 'link-complete',         description: '_plaidLinkComplete set (onSuccess fired)',   optional: false },
];

let schemaWarnings = 0;
for (const schema of STEP_TIMING_SCHEMA) {
  if (T[schema.key] == null) {
    const level = schema.optional ? 'info' : 'warn';
    const icon  = schema.optional ? '  ℹ' : '  ⚠';
    console[level === 'warn' ? 'warn' : 'log'](`${icon} [PostProcess] Step timing key "${schema.key}" not found — ${schema.description} section will be cut from processed video`);
    if (!schema.optional) schemaWarnings++;
  }
}
if (schemaWarnings > 0) {
  console.warn(`[PostProcess] ${schemaWarnings} required step-timing key(s) missing. The processed video may be missing critical sections.`);
}

checkFfmpeg();
const totalDuration = getVideoDuration(INPUT_PATH);

// ── Validate timestamps against recording duration ─────────────────────────
// Timestamps from plaid-link-timing.json may be from a different recording
// iteration if the best recording was restored without updating plaid-link-timing.
// Warn loudly and null out any timestamps that exceed the recording length.
{
  const staleKeys = [];
  for (const key of Object.keys(T)) {
    if (T[key] > totalDuration + 1.0) {  // 1s tolerance for encoder rounding
      staleKeys.push(`${key}=${T[key].toFixed(2)}s`);
      delete T[key];
    }
  }
  if (staleKeys.length > 0) {
    console.warn(`\n  ⚠ [PostProcess] STALE TIMING DETECTED — timestamps beyond recording duration (${totalDuration.toFixed(2)}s):`);
    console.warn(`  ⚠   ${staleKeys.join(', ')}`);
    console.warn(`  ⚠   These keys have been nulled. Range 4 (success+app) will use fallback.`);
    console.warn(`  ⚠   Root cause: plaid-link-timing.json is from a different recording iteration.`);
    console.warn(`  ⚠   Fix: ensure plaid-link-timing-iterN.json is restored with the best recording.\n`);
  }
}

console.log('\n[PostProcess] Step timing:');
for (const t of timings) {
  const offset = t.recordingOffsetS != null ? t.recordingOffsetS.toFixed(2) + 's' : 'N/A';
  console.log(`  ${t.step.padEnd(28)} ${offset}`);
}
console.log(`  ${'total duration'.padEnd(28)} ${totalDuration.toFixed(2)}s`);

// ── Define keep ranges ────────────────────────────────────────────────────────
//
// A keep range { start, end, label } tells ffmpeg to include those seconds.
// Everything outside the ranges is discarded (hard cut).
//
// Ranges MUST be non-overlapping and sorted by start time.
// They are clamped to [0, totalDuration].

const keepRanges = [];

function addKeep(start, end, label) {
  if (start == null || end == null) return;
  start = clamp(parseFloat(start.toFixed(3)), 0, totalDuration);
  end   = clamp(parseFloat(end.toFixed(3)),   0, totalDuration);
  if (end - start < 0.08) return;  // skip sub-frame slivers
  keepRanges.push({ start, end, label });
}

// ── Range 1: App start → phone Continue click ─────────────────────────────────
// Shows: app loading, phone screen (pre-filled), Continue clicked.
// End: a half-second after phone-submitted so the click lands visually.
addKeep(
  0,
  T['phone-submitted'] != null ? T['phone-submitted'] + PHONE_TAIL : null,
  'app + phone screen'
);

// ── Range 2a: OTP screen appearing (brief) ───────────────────────────────────
// Shows the OTP entry screen arriving. Cut before the long fill() wait.
// Hard cut from Range 1 removes the phone→OTP loading (~12s).
if (T['otp-screen'] != null) {
  addKeep(
    T['otp-screen'] - 0.2,
    T['otp-screen'] + 0.5,
    'otp screen appear'
  );
}

// ── Range 2b: OTP digits visible for 1s ──────────────────────────────────────
// Anchored to 'otp-filled' (recorded right after fill+1s pause).
// Hard cut from Range 2a removes the ~28s fill() wait.
// Falls back to otp-submitted if otp-filled is absent (older timing files).
{
  const anchor = T['otp-filled'] ?? T['otp-submitted'];
  if (anchor != null) {
    addKeep(
      anchor - 0.2,           // tiny lead-in: show digits appearing
      anchor + OTP_KEEP,      // then 1s (default) of filled digits visible
      'otp digits + hold'
    );
  }
}

// ── Range 3: Institution list → Confirm clicked (hard-capped at MAX_INST_S) ───
// RULE: institution section must be ≤ MAX_INST_S (default 4s) in the output.
//       For any Plaid Link flow, never exceed 5s for this section.
//
// Strategy:
//   - If raw section (institution-list-shown → confirm-clicked+0.5) already fits,
//     keep it as a single range.
//   - If it exceeds the cap, split into TWO sub-ranges:
//       Part A: [institution-list-shown - 0.2, institution-list-shown + LIST_PART_S]
//               Shows the bank list appearing and the bank being selected.
//       Part B: [confirm-clicked - CONFIRM_PART_S, confirm-clicked + 0.5]
//               Shows the account selection screen and Confirm being clicked.
//     The two parts sum to exactly MAX_INST_S seconds.
//     The cut between them removes the dwell/transition between bank-selected and account.
{
  const listStart   = T['institution-list-shown'];
  const confirmEnd  = T['confirm-clicked'] != null ? T['confirm-clicked'] + 0.5 : null;

  if (listStart != null && confirmEnd != null) {
    const LEAD_IN   = 0.2;  // lead-in before list-shown
    const TAIL      = 0.5;  // tail after confirm-clicked (already in confirmEnd)
    const rawDur    = confirmEnd - (listStart - LEAD_IN);

    if (rawDur <= MAX_INST_S + 0.05) {
      // Already within budget — single range
      addKeep(listStart - LEAD_IN, confirmEnd, 'institution → confirm');
    } else {
      // Split to fit within MAX_INST_S:
      //   LIST_PART_S    = 40% of budget (min MIN_PLAID_SCREEN_S) — list + bank click visible
      //   CONFIRM_PART_S = remaining budget (min MIN_PLAID_SCREEN_S) — account + confirm click
      // With MAX_INST_S=5.0: budget=4.3s → LIST=max(2.0,1.72)=2.0s, CONFIRM=2.3s ✓
      const budget         = MAX_INST_S - LEAD_IN - TAIL;  // content seconds available
      const MIN_PART_S     = MIN_PLAID_SCREEN_MS / 1000;
      const LIST_PART_S    = Math.max(MIN_PART_S, budget * 0.40);
      const CONFIRM_PART_S = Math.max(MIN_PART_S, budget - LIST_PART_S);

      addKeep(listStart - LEAD_IN, listStart + LIST_PART_S,          'institution list (capped)');
      addKeep(confirmEnd - TAIL - CONFIRM_PART_S, confirmEnd,         'account → confirm (capped)');
      console.log(`  [PostProcess] Institution section capped: ${rawDur.toFixed(2)}s → ${MAX_INST_S}s (split at list+${LIST_PART_S.toFixed(1)}s / confirm-${CONFIRM_PART_S.toFixed(1)}s)`);
    }
  } else if (listStart != null) {
    // No confirm timestamp — just keep 4s of the list
    addKeep(listStart - 0.2, listStart + MAX_INST_S - 0.2, 'institution list (no confirm)');
  }
}

// ── Range 4: Success screen + all subsequent app screens ─────────────────────
// Starts at 'link-complete' (when _plaidLinkComplete fires and the host page
// success panel appears). Extends to END OF RECORDING — this preserves the full
// post-Link app experience: auth/get insight screen, identity/match insight screen,
// signal/evaluate insight screen, and the final funding confirmation + CTA screens.
//
// The SUCCESS_KEEP param is kept for backwards-compat but is no longer used to cap
// the range — it only controls the minimum kept duration in case the recording ends
// immediately after link-complete (short test runs).
//
// Hard cut from Range 3 removes the Confirm → success wait (~10-15s).
{
  const successStart = T['link-complete'] != null
    ? T['link-complete']                           // exact moment success panel appears
    : T['confirm-clicked'] != null
      ? T['confirm-clicked'] + 10                  // fallback: guess ~10s after confirm
      : T['otp-filled'] != null
        ? T['otp-filled'] + 20                     // fallback: ~20s after OTP filled covers typical Remember Me completion
        : totalDuration - SUCCESS_KEEP;            // last-resort: keep only the tail of the recording
  if (successStart != null) {
    addKeep(
      Math.min(successStart, totalDuration - SUCCESS_KEEP),
      totalDuration,   // keep to end: success screen + all app insight + funding screens
      'success + app screens'
    );
  }
}

// ── Validate ──────────────────────────────────────────────────────────────────

// Sort + deduplicate (merge any accidental overlaps)
keepRanges.sort((a, b) => a.start - b.start);

// Check for overlaps (shouldn't happen with the above logic)
for (let i = 1; i < keepRanges.length; i++) {
  if (keepRanges[i].start < keepRanges[i - 1].end) {
    // Merge: extend previous to cover both
    console.warn(`  [warn] Merging overlapping ranges: "${keepRanges[i-1].label}" and "${keepRanges[i].label}"`);
    keepRanges[i - 1].end = Math.max(keepRanges[i - 1].end, keepRanges[i].end);
    keepRanges.splice(i, 1);
    i--;
  }
}

if (keepRanges.length === 0) {
  console.warn('[PostProcess] No keep ranges defined (no Plaid phase timestamps available).');
  console.warn('[PostProcess] Keeping full recording — no cuts will be made.');
  addKeep(0, totalDuration, 'full recording (no phase timing)');
}

const keptTotal = keepRanges.reduce((s, r) => s + (r.end - r.start), 0);
const cutTotal  = totalDuration - keptTotal;

console.log('\n[PostProcess] Keep ranges (everything else is cut):');
for (const r of keepRanges) {
  const dur = (r.end - r.start).toFixed(2);
  console.log(`  [${r.start.toFixed(2)}s → ${r.end.toFixed(2)}s]  ${dur}s  "${r.label}"`);
}
console.log(`\n  Kept:   ${keptTotal.toFixed(2)}s`);
console.log(`  Cut:    ${cutTotal.toFixed(2)}s  (${Math.round(cutTotal / totalDuration * 100)}% removed)`);
console.log(`  Input:  ${totalDuration.toFixed(2)}s  →  Output est: ${keptTotal.toFixed(2)}s`);

// ── Write processed-step-timing.json ──────────────────────────────────────────
//
// Maps each keep range to its cumulative position in the processed video so that
// generate-voiceover.js can remap raw step timings to processed-video coordinates.
// Format: { totalProcessedMs, keepRanges: [{ label, rawStart, rawEnd, processedStart, processedEnd }] }
//
// This file is written unconditionally (even in --dry-run, since it derives from
// keepRanges which are already computed). generate-voiceover.js reads it only when
// it exists, so old runs without it fall back to raw step-timing.json.

{
  let cursor = 0;
  const mappedRanges = keepRanges.map(r => {
    const dur   = r.end - r.start;
    const entry = {
      label:          r.label,
      rawStart:       r.start,
      rawEnd:         r.end,
      processedStart: parseFloat(cursor.toFixed(3)),
      processedEnd:   parseFloat((cursor + dur).toFixed(3)),
    };
    cursor += dur;
    return entry;
  });

  // ── Synthesize processed step timing for Plaid Link sub-steps ──────────────
  // The 4 Plaid Link steps (link-consent, link-otp, link-account-select, link-success)
  // are not in step-timing.json (they're covered by the launch step's single block).
  // Map each phase timestamp from plaid-link-timing.json to processed-video coordinates
  // so generate-voiceover.js can assign narration to them and QA can find their frames.
  //
  // Phase → step ID mapping (matches PLAID_PHASE_TO_STEP_ID in record-local.js):
  //   phone-submitted        → link-consent        (phone consent visible)
  //   otp-screen             → link-otp            (OTP input visible)
  //   institution-list-shown → link-account-select (institution list visible)
  //   link-complete          → link-success        (success state)
  //
  // Each window runs from the phase start to the next phase start (or link-complete + 1s).

  function rawToProcessedMs(rawS) {
    // Convert a raw-recording timestamp (seconds) to processed-video time (ms).
    // Clamps to the nearest keep range boundary if the timestamp falls in a cut section.
    let cumulative = 0;
    for (const r of mappedRanges) {
      if (rawS >= r.rawStart && rawS <= r.rawEnd) {
        return Math.round((cumulative + (rawS - r.rawStart)) * 1000);
      }
      if (rawS < r.rawStart) {
        // Falls in a cut section before this range — snap to range start
        return Math.round(cumulative * 1000);
      }
      cumulative += (r.rawEnd - r.rawStart);
    }
    return Math.round(cumulative * 1000); // past all ranges
  }

  const plaidStepWindows = [];
  const phaseMap = [
    { phase: 'phone-submitted',        stepId: 'link-consent',       nextPhase: 'otp-screen' },
    { phase: 'otp-screen',             stepId: 'link-otp',           nextPhase: 'institution-list-shown' },
    { phase: 'institution-list-shown', stepId: 'link-account-select',nextPhase: 'confirm-clicked' },
    { phase: 'link-complete',          stepId: 'link-success',       nextPhase: null },
  ];

  for (const { phase, stepId, nextPhase } of phaseMap) {
    if (T[phase] == null) continue;
    const rawStartS = T[phase];
    // link-success has no nextPhase — use at least MIN_PLAID_SCREEN_S of footage.
    // In normal flows there are 90+ seconds of raw video after link-complete, so
    // this never hits the end of recording.
    const rawEndS = nextPhase && T[nextPhase] != null
      ? T[nextPhase]
      : rawStartS + Math.max(MIN_PLAID_SCREEN_MS / 1000, SUCCESS_KEEP);
    const startMs = rawToProcessedMs(rawStartS);
    const endMs   = rawToProcessedMs(rawEndS);
    const durationMs = endMs - startMs;

    // Phantom windows: the two raw timestamps are nearly simultaneous (< MIN_EMIT_MS apart
    // in processed space). In Remember Me flow, phone-submitted ≈ otp-screen — the phone
    // screen WAS visible for many seconds before phone-submitted fired, so this is a
    // measurement artifact, not a real 10ms screen. Don't emit as a sub-step window.
    if (durationMs < MIN_EMIT_MS) {
      console.log(`  [PostProcess] ${stepId}: ${durationMs}ms processed window — phantom transition, skipping`);
      continue;
    }

    const window = { stepId, startMs, endMs, durationMs, rawStartS, rawEndS };

    // Minimum screen duration enforcement:
    // If the processed window is shorter than MIN_PLAID_SCREEN_MS, tag it with freezeMs.
    // orchestrator.js buildRemotionProps() will inject a Remotion freeze segment to pad
    // the screen to the minimum before the next cut fires.
    if (durationMs < MIN_PLAID_SCREEN_MS) {
      window.freezeMs = MIN_PLAID_SCREEN_MS - durationMs;
      console.warn(`  [PostProcess] ${stepId}: ${durationMs}ms < ${MIN_PLAID_SCREEN_MS}ms minimum — adding ${window.freezeMs}ms Remotion freeze`);
    }

    plaidStepWindows.push(window);
  }

  const processedTimingPath = path.join(path.dirname(OUTPUT_PATH), 'processed-step-timing.json');
  fs.writeFileSync(processedTimingPath, JSON.stringify({
    totalProcessedMs: Math.round(keptTotal * 1000),
    keepRanges:       mappedRanges,
    plaidStepWindows, // Processed-space timing for Plaid Link sub-steps
  }, null, 2));
  console.log(`\n[PostProcess] Wrote processed-step-timing.json`);
  for (const r of mappedRanges) {
    console.log(`  [${r.processedStart.toFixed(2)}s → ${r.processedEnd.toFixed(2)}s]  "${r.label}"  (raw ${r.rawStart.toFixed(2)}s–${r.rawEnd.toFixed(2)}s)`);
  }
  if (plaidStepWindows.length > 0) {
    console.log(`\n[PostProcess] Plaid Link sub-step windows (processed-space):`);
    for (const w of plaidStepWindows) {
      const effectiveMs = w.durationMs + (w.freezeMs || 0);
      const freezeNote  = w.freezeMs ? `  +${w.freezeMs}ms freeze → ${effectiveMs}ms effective` : '';
      console.log(`  ${w.stepId.padEnd(25)} ${(w.startMs/1000).toFixed(2)}s → ${(w.endMs/1000).toFixed(2)}s  (${w.durationMs}ms)${freezeNote}`);
    }
  }
}

// ── Build ffmpeg filter_complex ───────────────────────────────────────────────
//
// Each keep range becomes one trim segment.
// All segments are PTS-reset and concatenated in order.
//
// filter_complex structure:
//   [0:v]split=N[vs0][vs1]...[vsN-1];
//   [vs0]trim=start=S0:end=E0,setpts=PTS-STARTPTS[seg0];
//   ...
//   [seg0][seg1]...[segN-1]concat=n=N:v=1:a=0[out]

const n = keepRanges.length;

const filterParts = [
  `[0:v]split=${n}${keepRanges.map((_, i) => `[vs${i}]`).join('')}`,
];

for (let i = 0; i < n; i++) {
  const { start, end } = keepRanges[i];
  filterParts.push(`[vs${i}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[seg${i}]`);
}

filterParts.push(
  `${keepRanges.map((_, i) => `[seg${i}]`).join('')}concat=n=${n}:v=1:a=0[out]`
);

const filterComplex = filterParts.join('; ');

// Build the full command string (quote the filter_complex arg which contains spaces/brackets)
const cmdParts = [
  'ffmpeg', '-y',
  '-i', `"${INPUT_PATH}"`,
  '-filter_complex', `"${filterComplex.replace(/"/g, '\\"')}"`,
  '-map', '[out]',
  '-an',
  '-c:v', 'vp8',
  '-b:v', '8000k',   // high bitrate for 2880×1800 — prevents compression artefacts
  '-crf', '10',      // near-lossless quality target (vp8 CRF: lower = better)
  '-deadline', 'good',
  `"${OUTPUT_PATH}"`,
];
const cmd = cmdParts.join(' ');

console.log('\n[PostProcess] ffmpeg filter_complex:');
const fcDisplay = filterComplex.replace(/; /g, '\n    ');
console.log(`    ${fcDisplay}`);

if (isDryRun) {
  console.log('\n[PostProcess] Dry-run mode — command built but not executed.');
  process.exit(0);
}

// ── Execute ───────────────────────────────────────────────────────────────────

console.log('\n[PostProcess] Running ffmpeg...');
const t_start = Date.now();

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  die(`ffmpeg failed. Try --dry-run to inspect the command.\n${err.message}`);
}

const elapsed = ((Date.now() - t_start) / 1000).toFixed(1);
const outSize  = fs.existsSync(OUTPUT_PATH) ? (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(0) + 'KB' : '?';
const outDur   = fs.existsSync(OUTPUT_PATH) ? getVideoDuration(OUTPUT_PATH).toFixed(2) + 's' : '?';

console.log(`\n[PostProcess] Done in ${elapsed}s`);
console.log(`  Output:      ${OUTPUT_PATH}`);
console.log(`  Size:        ${outSize}`);
console.log(`  Duration:    ${outDur}  (was ${totalDuration.toFixed(2)}s, cut ${cutTotal.toFixed(2)}s)`);
console.log(`  Removed:     ${Math.round(cutTotal / totalDuration * 100)}% of original`);

if (isPreview) {
  console.log('\n[PostProcess] Opening in default video player...');
  try { execSync(`open "${OUTPUT_PATH}"`); } catch (_) {}
}

console.log('\n[PostProcess] Done. To preview:');
console.log(`  open "${OUTPUT_PATH}"`);
console.log('\n[PostProcess] Tune keep windows:');
console.log(`  --otp-keep ${OTP_KEEP}  --success-keep ${SUCCESS_KEEP}  --phone-tail ${PHONE_TAIL}  --max-institution ${MAX_INST_S}`);
console.log(`  (institution rule: ≥${MIN_PLAID_SCREEN_MS/1000}s per screen, default MAX_INST_S=${MAX_INST_S}s)\n`);
