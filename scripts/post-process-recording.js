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
 *   --max-institution N  Hard cap on institution list section in output (default: 4.0)
 *                        Section is split (list-appear | account+confirm) to fit within N seconds.
 *                        Use 5.0 for non-Remember-Me flows with more screens. RULE: ≤4s default.
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
// RULE: ≤4s for Remember Me (Tartan Bank). ≤5s for any other Plaid Link flow.
const MAX_INST_S   = parseFloat(getArg('--max-institution', '4.0'));

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
      //   LIST_PART_S  = 40% of budget (min 1.2s) — list + bank click visible
      //   CONFIRM_PART_S = remaining budget    — account screen + confirm click
      const budget        = MAX_INST_S - LEAD_IN - TAIL;  // content seconds available
      const LIST_PART_S   = Math.max(1.2, budget * 0.40);
      const CONFIRM_PART_S = budget - LIST_PART_S;

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
      : null;
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

  const processedTimingPath = path.join(path.dirname(OUTPUT_PATH), 'processed-step-timing.json');
  fs.writeFileSync(processedTimingPath, JSON.stringify({
    totalProcessedMs: Math.round(keptTotal * 1000),
    keepRanges:       mappedRanges,
  }, null, 2));
  console.log(`\n[PostProcess] Wrote processed-step-timing.json`);
  for (const r of mappedRanges) {
    console.log(`  [${r.processedStart.toFixed(2)}s → ${r.processedEnd.toFixed(2)}s]  "${r.label}"  (raw ${r.rawStart.toFixed(2)}s–${r.rawEnd.toFixed(2)}s)`);
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
console.log('  (institution rule: ≤4s default, ≤5s max for any Plaid Link flow)\n');
