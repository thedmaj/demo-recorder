/**
 * ScratchComposition.jsx
 * Remotion composition for Mode A (Claude-built demo apps).
 * Base: recorded video + ElevenLabs voiceover
 * Overlays: callouts from demo-script.json, lower-thirds, zoom punches
 *
 * NOTE: Frames from 00:56.18 to 01:11.21 are cut from the VIDEO only.
 * Audio plays uninterrupted; the video skips that segment seamlessly.
 *
 * Cut implementation: two Sequence windows each holding an OffthreadVideo
 * with a fixed startFrom. This is the correct Remotion pattern — OffthreadVideo
 * does NOT support dynamic startFrom.
 *
 *  Segment A: composition frames [0, CUT_START_F)  → video frames [0, CUT_START_F)
 *             startFrom = 0
 *
 *  Segment B: composition frames [CUT_START_F, end) → video frames [CUT_END_F, …)
 *             The Sequence starts at CUT_START_F, so Remotion passes the video
 *             relativeFrame = compositionFrame - CUT_START_F.
 *             We need videoFrame = relativeFrame + CUT_END_F, so startFrom = CUT_END_F.
 *
 * SYNC MAP — freeze / speed adjustments:
 *   Each entry describes a composition-time window and how video time advances:
 *     { compStart, compEnd, videoStart, mode: 'freeze' | 'speed', speed? }
 *   - 'freeze': video is held at videoStart for the entire window
 *   - 'speed' : video plays at `speed` rate (>1 = faster, <1 = slower)
 *               videoEnd = videoStart + (compEnd - compStart) * speed
 *
 *  These are expressed in SECONDS for readability and converted to frames below.
 *  All comp times are AFTER the cut is already applied (i.e. they refer to the
 *  shortened composition timeline, not the raw recording timeline).
 *
 *  Annotate with the behaviour you need:
 *    Freeze  → audio is talking but screen is static / loading → hold frame
 *    Speed   → screen transitions are slow / silent → speed up to match audio
 */

const {
  AbsoluteFill,
  OffthreadVideo,
  Audio,
  staticFile,
  Sequence,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
} = require('remotion');

// ── Design tokens ──────────────────────────────────────────────────────────────
const PLAID_BLACK = '#0d1117';
const PLAID_WHITE = '#ffffff';
const PLAID_TEAL  = '#00A67E';
const FONT_STACK  = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

// ── Cut definition ────────────────────────────────────────────────────────────
// Set to past end-of-video to effectively disable the Remotion-level cut.
// All editing is handled by ffmpeg in post-process-recording.js. The sync map
// below handles any remaining speed/freeze adjustments within Remotion.
const CUT_START_S    = 143.0;   // past end of processed video (142.3s) — no cut
const CUT_END_S      = 143.0;

// ── Sync map ──────────────────────────────────────────────────────────────────
// Edit these entries to tune audio/video alignment.
// All times are in SECONDS on the composition timeline (= processed video time
// when CUT_START_S is set past the video end, as above).
// videoStart is the corresponding time in the processed video (recording-processed.webm).
//
// Tip: step positions in the processed video are in voiceover-manifest.json
// (startMs values, before any voiceoverStartOffsetMs is added).
const SYNC_MAP_S = [
  // ── Plaid Link experience: 1.3× speed-up ──────────────────────────────────
  // wf-link-launch step spans processed video 13.0 → 44.216s (31.216s).
  // At 1.3×: 31.216 / 1.3 = 24.01s of composition time, ending at comp 37.0s.
  { compStart: 13.0, compEnd: 37.0, videoStart: 13.0, mode: 'speed', speed: 1.3 },

  // ── Re-sync freeze: hold "account linked" screen while audio catches up ─────
  // After the 1.3× speed-up the video head is at 44.2s but comp is at 37.0s.
  // Jump the freeze to video 47.5s (3.3s into account-linked step) and hold
  // until comp 47.5s — after which 1:1 sync is restored for all remaining steps.
  { compStart: 37.0, compEnd: 47.5, videoStart: 47.5, mode: 'freeze' },
];

// ── Reusable fade helper ───────────────────────────────────────────────────────
function useFade(frame, inStart, inEnd, outStart, outEnd) {
  return interpolate(
    frame,
    [inStart, inEnd, outStart, outEnd],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
}

// ── Click ripple (teal concentric ring at click position) ─────────────────────
function ClickRipple({ xFrac, yFrac, atFrame, relFrame }) {
  const { fps } = useVideoConfig();
  const local = relFrame - atFrame;
  if (local < 0 || local > 45) return null;

  const scale   = spring({ frame: local, fps, config: { damping: 18, stiffness: 200 } });
  const opacity = interpolate(local, [0, 8, 30, 45], [0, 1, 1, 0], { extrapolateRight: 'clamp' });

  return (
    <div style={{
      position:     'absolute',
      left:         `${xFrac * 100}%`,
      top:          `${yFrac * 100}%`,
      width:        120,
      height:       120,
      transform:    `translate(-50%, -50%) scale(${scale})`,
      border:       '3px solid rgba(0,166,126,0.8)',
      borderRadius: '50%',
      opacity,
      pointerEvents: 'none',
    }} />
  );
}

// ── Cross-dissolve on hard cuts ────────────────────────────────────────────────
function CrossDissolve({ frame, cutFrames }) {
  if (!cutFrames || cutFrames.length === 0) return null;
  const nearest = cutFrames.reduce((min, cf) => Math.min(min, Math.abs(frame - cf)), Infinity);
  if (nearest > 6) return null;
  const opacity = interpolate(nearest, [0, 6], [0.6, 0], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ background: '#000', opacity, pointerEvents: 'none' }} />;
}

// ── Stat counter (number counts up from 0) ────────────────────────────────────
function StatCounter({ value, suffix, label, position, relFrame, durationFrames }) {
  const counted = Math.floor(
    interpolate(relFrame, [0, durationFrames * 0.6], [0, value], {
      extrapolateLeft:  'clamp',
      extrapolateRight: 'clamp',
    })
  );

  // stat-1/2/3 → left/center/right in a bottom banner row
  const xMap = { 'stat-1': '20%', 'stat-2': '50%', 'stat-3': '80%' };
  const left = xMap[position] || '50%';

  return (
    <div style={{
      position:   'absolute',
      bottom:     180,
      left,
      transform:  'translateX(-50%)',
      display:    'flex',
      flexDirection: 'column',
      alignItems: 'center',
      pointerEvents: 'none',
      fontFamily: FONT_STACK,
    }}>
      <div style={{ fontSize: 56, fontWeight: 700, color: PLAID_TEAL, lineHeight: 1 }}>
        {counted}{suffix}
      </div>
      {label && (
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', marginTop: 6 }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ── Badge callout (glassmorphism pill) ────────────────────────────────────────
function BadgeCallout({ callout, relFrame, durationFrames }) {
  const { fps } = useVideoConfig();

  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 14, stiffness: 120, mass: 0.8 },
  });

  const opacity = useFade(relFrame, 0, 12, durationFrames - 15, durationFrames - 3);

  const positionStyle = resolvePosition(callout.position || 'top-right');

  return (
    <div style={{
      position: 'absolute',
      ...positionStyle,
      opacity,
      transform: `scale(${scale})`,
      background: 'rgba(0,166,126,0.15)',
      border: '1.5px solid rgba(0,166,126,0.45)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      borderRadius: 24,
      padding: '10px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      pointerEvents: 'none',
      maxWidth: 320,
    }}>
      {callout.icon && (
        <span style={{ fontSize: 16, lineHeight: 1 }}>{callout.icon}</span>
      )}
      <span style={{
        color: PLAID_WHITE,
        fontFamily: FONT_STACK,
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: 0.2,
        lineHeight: 1.3,
      }}>
        {callout.text || callout.label}
      </span>
    </div>
  );
}

// ── Lower-third overlay ────────────────────────────────────────────────────────
function LowerThirdCallout({ callout, relFrame, durationFrames }) {
  const y = interpolate(
    relFrame,
    [0, 18],
    [60, 0],
    { extrapolateRight: 'clamp' }
  );
  const opacity = useFade(relFrame, 0, 12, durationFrames - 15, durationFrames - 3);

  return (
    <div style={{
      position: 'absolute',
      bottom: 32,
      left: 0,
      right: 0,
      opacity,
      transform: `translateY(${y}px)`,
      pointerEvents: 'none',
      padding: '0 48px',
    }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        background: 'rgba(13,17,23,0.85)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      }}>
        {/* Teal accent bar */}
        <div style={{
          width: 4,
          background: PLAID_TEAL,
          flexShrink: 0,
        }} />
        <div style={{ padding: '10px 18px' }}>
          <div style={{
            color: PLAID_WHITE,
            fontFamily: FONT_STACK,
            fontWeight: 700,
            fontSize: 15,
            letterSpacing: 0.2,
          }}>
            {callout.title || callout.text}
          </div>
          {callout.subtext && (
            <div style={{
              color: 'rgba(255,255,255,0.6)',
              fontFamily: FONT_STACK,
              fontWeight: 400,
              fontSize: 12,
              marginTop: 2,
            }}>
              {callout.subtext}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Position resolver ──────────────────────────────────────────────────────────
function resolvePosition(position) {
  switch (position) {
    case 'top-left':     return { top: 20, left: 20 };
    case 'top-center':   return { top: 20, left: '50%', transform: 'translateX(-50%)' };
    case 'top-right':    return { top: 20, right: 20 };
    case 'center-left':  return { top: '40%', left: 20 };
    case 'center-right': return { top: '40%', right: 20 };
    case 'bottom-left':  return { bottom: 100, left: 20 };
    case 'bottom-right': return { bottom: 100, right: 20 };
    default:             return { top: 20, right: 20 };
  }
}

// ── Render callouts for a single step ─────────────────────────────────────────
function renderStepOverlays(step, frame) {
  const startFrame = step.startFrame ?? 0;
  const endFrame   = step.endFrame   ?? startFrame + 300;

  if (frame < startFrame || frame >= endFrame) return null;

  const relFrame       = frame - startFrame;
  const durationFrames = endFrame - startFrame;
  const callouts       = step.callouts || [];
  const elements       = [];

  // Click ripple at the element's position
  if (step.clickRipple) {
    elements.push(
      <ClickRipple
        key={`${step.id}-ripple`}
        xFrac={step.clickRipple.xFrac}
        yFrac={step.clickRipple.yFrac}
        atFrame={step.clickRipple.atFrame ?? 15}
        relFrame={relFrame}
      />
    );
  }

  // Callouts: lower-thirds, stat-counters, badge (default)
  callouts.forEach((callout, i) => {
    const key = `${step.id}-callout-${i}`;

    if (callout.type === 'stat-counter') {
      elements.push(
        <StatCounter
          key={key}
          value={callout.value}
          suffix={callout.suffix || ''}
          label={callout.label || ''}
          position={callout.position || 'stat-1'}
          relFrame={relFrame}
          durationFrames={durationFrames}
        />
      );
    } else if (callout.type === 'lower-third') {
      elements.push(
        <LowerThirdCallout
          key={key}
          callout={callout}
          relFrame={relFrame}
          durationFrames={durationFrames}
        />
      );
    } else {
      elements.push(
        <BadgeCallout
          key={key}
          callout={callout}
          relFrame={relFrame}
          durationFrames={durationFrames}
        />
      );
    }
  });

  return elements;
}

// ── Zoom punch wrapper ─────────────────────────────────────────────────────────
// zoomPunch may be:
//   true              → default 1.08× center-zoom (backwards-compat)
//   { scale, peakFrac, originX, originY }  → targeted zoom with click origin
function ZoomPunchWrapper({ step, frame, children }) {
  const zp = step?.zoomPunch;
  if (!zp) return <>{children}</>;

  const startFrame  = step.startFrame ?? 0;
  const endFrame    = step.endFrame   ?? startFrame + 300;

  const targetScale = (typeof zp === 'object' ? zp.scale   : null) ?? 1.08;
  const peakFrac    = (typeof zp === 'object' ? zp.peakFrac : null) ?? 0.5;
  const originX     = (typeof zp === 'object' ? zp.originX  : null) ?? 'center';
  const originY     = (typeof zp === 'object' ? zp.originY  : null) ?? 'center';

  const peakFrame = startFrame + Math.round((endFrame - startFrame) * peakFrac);
  const punchIn   = startFrame + 10;
  const punchOut  = endFrame   - 10;

  const scale = interpolate(
    frame,
    [startFrame, punchIn, peakFrame, punchOut, endFrame],
    [1.0, 1.0, targetScale, targetScale, 1.0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${originX} ${originY}` }}>
      {children}
    </AbsoluteFill>
  );
}

// ── Sync-map segment builder ───────────────────────────────────────────────────
/**
 * Converts SYNC_MAP_S (seconds) into frame-level segments that describe
 * exactly which video frame to show at each composition frame.
 *
 * Returns an array of segments sorted by compStart:
 *   { compStartF, compEndF, videoStartF, mode, speed }
 *
 * Gaps between sync entries are filled with normal 1:1 playback segments.
 * The raw video timeline is tracked via `videoHeadF` so that consecutive
 * normal-play segments stay perfectly stitched.
 */
function buildSyncSegments(fps, cutStartF, cutEndF, totalFrames, syncMapProp) {
  // Use syncMap from props if provided; fall back to the module-level SYNC_MAP_S constant.
  // The module-level constant is kept as a last-resort fallback for Remotion Studio sessions
  // that load without --props. In a full pipeline run, syncMap always comes from remotion-props.json.
  const activeSyncMap = (syncMapProp && syncMapProp.length > 0) ? syncMapProp : SYNC_MAP_S;

  // Convert sync map to frames, clamping to post-cut composition range.
  // Comp times are already post-cut (caller's responsibility).
  const entries = activeSyncMap
    .map(e => ({
      compStartF : Math.round(e.compStart  * fps),
      compEndF   : Math.round(e.compEnd    * fps),
      videoStartF: Math.round(e.videoStart * fps),
      mode       : e.mode,
      speed      : e.speed ?? 1,
    }))
    .sort((a, b) => a.compStartF - b.compStartF);

  const segments = [];

  // We walk the composition timeline in two zones:
  //   Zone A: comp frames [0, cutStartF)   → raw video frames with same offset
  //   Zone B: comp frames [cutStartF, end) → raw video frames offset by (cutEndF - cutStartF)
  //
  // For the sync map we just need to know: given compFrame, what videoFrame?
  // Without any sync entry: videoFrame = compFrame  (Zone A)
  //                         videoFrame = compFrame + (cutEndF - cutStartF)  (Zone B)
  // We handle the cut separately in CutVideo, so here we emit segments
  // per-zone. Each Sequence inside CutVideo will use these segments to
  // select the right startFrom.

  // Build a flat list of {compStartF, compEndF, videoStartF, mode, speed} covering
  // the full timeline, filling gaps with normal (speed=1) play.
  let compHead = 0;
  let videoHead = 0; // raw recording head (no cut applied yet)

  function advanceVideoHead(compStart, compEnd) {
    // Normal play: video advances 1:1 with composition up to this point
    return videoHead + (compStart - compHead);
  }

  for (const entry of entries) {
    // Fill gap before this entry with normal play
    if (entry.compStartF > compHead) {
      const vStart = videoHead + (entry.compStartF - compHead);
      segments.push({
        compStartF : compHead,
        compEndF   : entry.compStartF,
        videoStartF: videoHead,
        mode       : 'normal',
        speed      : 1,
      });
      videoHead = vStart;
      compHead  = entry.compStartF;
    }

    // The entry itself
    segments.push(entry);
    compHead = entry.compEndF;

    // Advance video head based on mode
    if (entry.mode === 'freeze') {
      // Video time does not advance during a freeze
      videoHead = entry.videoStartF;
    } else {
      // speed or normal: video advances by comp-duration * speed
      const compDur = entry.compEndF - entry.compStartF;
      videoHead = entry.videoStartF + Math.round(compDur * (entry.speed ?? 1));
    }
  }

  // Fill trailing gap
  if (compHead < totalFrames) {
    segments.push({
      compStartF : compHead,
      compEndF   : totalFrames,
      videoStartF: videoHead,
      mode       : 'normal',
      speed      : 1,
    });
  }

  return segments;
}

// ── Two-segment video player implementing the cut + sync adjustments ───────────
//
// Strategy:
//   1. Build sync segments covering the full comp timeline.
//   2. Split them at cutStartF into Zone-A and Zone-B buckets.
//   3. For each bucket, render one <Sequence> per sync segment containing an
//      <OffthreadVideo> with the right startFrom.
//
// For FREEZE segments the video is held by setting:
//   startFrom = videoStartF  (same frame for every relativeFrame in the window)
//   This is achieved by giving the OffthreadVideo a startFrom equal to
//   videoStartF and wrapping it in a Sequence whose durationInFrames = 1,
//   repeated for every frame in the window — but Remotion doesn't support
//   that directly.  Instead we use the simpler approach: render a still image
//   by making the Sequence 1 frame wide and the OffthreadVideo cover it,
//   layered under a transparent duplicate for the full window.
//
// SIMPLER CORRECT APPROACH FOR FREEZE:
//   Use Remotion's <Freeze> component (available in remotion >= 3.3).
//   Wrap OffthreadVideo in <Freeze at={videoStartF}> inside the Sequence.
//
// For SPEED segments:
//   playbackRate prop on OffthreadVideo controls speed.
const { Freeze } = require('remotion');

function SyncedVideo({ src, videoStyle, zoomStep, frame, fps, cutStartF, cutEndF, totalFrames, syncMap }) {
  const segments = buildSyncSegments(fps, cutStartF, cutEndF, totalFrames, syncMap);

  // Split segments into Zone A (before cut) and Zone B (after cut)
  const zoneA = [];
  const zoneB = [];

  for (const seg of segments) {
    // Clip to zone A
    if (seg.compStartF < cutStartF) {
      const clipped = {
        ...seg,
        compStartF: seg.compStartF,
        compEndF  : Math.min(seg.compEndF, cutStartF),
      };
      zoneA.push(clipped);
    }
    // Clip to zone B
    if (seg.compEndF > cutStartF) {
      const clipped = {
        ...seg,
        compStartF: Math.max(seg.compStartF, cutStartF),
        compEndF  : seg.compEndF,
      };
      // videoStartF must account for the cut gap when in zone B
      // For zone B, raw video frame = videoStartF + CUT_DURATION
      // but only if the segment started in zone A (i.e. it straddles the cut).
      // If the segment is entirely in zone B its videoStartF was already
      // computed relative to the post-cut video head which already skips the
      // cut. We add the cut gap unconditionally here because buildSyncSegments
      // does NOT know about the cut — it treats the timeline as linear.
      clipped.videoStartF = clipped.videoStartF + (cutEndF - cutStartF);
      zoneB.push(clipped);
    }
  }

  function maybeZoom(child) {
    if (!zoomStep) return <AbsoluteFill>{child}</AbsoluteFill>;
    return (
      <ZoomPunchWrapper step={zoomStep} frame={frame}>
        {child}
      </ZoomPunchWrapper>
    );
  }

  function renderSegment(seg, zoneOffset, key) {
    const compDur = seg.compEndF - seg.compStartF;
    if (compDur <= 0) return null;

    // Within the Sequence, relativeFrame goes 0 … compDur-1.
    // We need videoFrame = seg.videoStartF + relativeFrame * speed
    // For freeze:  videoFrame = seg.videoStartF always → use <Freeze>
    // For normal/speed: playbackRate = speed, startFrom = seg.videoStartF

    const inner =
      seg.mode === 'freeze' ? (
        <Freeze frame={seg.videoStartF}>
          <OffthreadVideo
            src={staticFile(src)}
            startFrom={0}
            volume={0}
            style={videoStyle}
          />
        </Freeze>
      ) : (
        <OffthreadVideo
          src={staticFile(src)}
          startFrom={seg.videoStartF}
          playbackRate={seg.speed ?? 1}
          volume={0}
          style={videoStyle}
        />
      );

    return (
      <Sequence
        key={key}
        from={seg.compStartF - zoneOffset}
        durationInFrames={compDur}
      >
        {maybeZoom(inner)}
      </Sequence>
    );
  }

  const segAFrames = Math.min(cutStartF, totalFrames);
  const segBFrames = Math.max(0, totalFrames - cutStartF);

  return (
    <>
      {/* Zone A — comp frames [0, cutStartF) */}
      {segAFrames > 0 && (
        <Sequence from={0} durationInFrames={segAFrames}>
          {zoneA.map((seg, i) => renderSegment(seg, 0, `a-${i}`))}
        </Sequence>
      )}

      {/* Zone B — comp frames [cutStartF, end) — empty when cut is past video end */}
      {segBFrames > 0 && (
        <Sequence from={cutStartF} durationInFrames={segBFrames}>
          {zoneB.map((seg, i) => renderSegment(seg, cutStartF, `b-${i}`))}
        </Sequence>
      )}
    </>
  );
}

// ── Main composition ───────────────────────────────────────────────────────────
const ScratchComposition = ({ steps = [], voiceoverFile = 'voiceover.mp3', hasVoiceover = true, cutFrames = [], syncMap = [] }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const cutStartF = Math.round(CUT_START_S * fps);
  const cutEndF   = Math.round(CUT_END_S   * fps);

  // Find the step that has a zoomPunch active at this frame
  const zoomStep = steps.find(s =>
    s.zoomPunch &&
    frame >= (s.startFrame ?? 0) &&
    frame < (s.endFrame ?? (s.startFrame ?? 0) + 300)
  );

  // Audio ducking: dip 15% for 20 frames centered on each click ripple
  const clickFrames = steps
    .filter(s => s.clickRipple)
    .map(s => (s.startFrame ?? 0) + (s.clickRipple.atFrame ?? 15));

  const volume = clickFrames.reduce((vol, cf) => {
    const dist = Math.abs(frame - cf);
    if (dist > 10) return vol;
    const dip = interpolate(dist, [0, 10], [0.15, 0], { extrapolateRight: 'clamp' });
    return Math.max(0, vol - dip);
  }, 1.0);

  const videoStyle = { width: '100%', height: '100%', objectFit: 'cover' };

  return (
    <AbsoluteFill style={{ background: PLAID_BLACK, overflow: 'hidden' }}>

      {/* ── Base video layer: cut + sync adjustments ── */}
      <SyncedVideo
        src="recording.webm"
        videoStyle={videoStyle}
        zoomStep={zoomStep}
        frame={frame}
        fps={fps}
        cutStartF={cutStartF}
        cutEndF={cutEndF}
        totalFrames={durationInFrames}
        syncMap={syncMap}
      />

      {/* ── Voiceover audio (plays continuously, unaffected by video cut) ── */}
      {hasVoiceover && <Audio src={staticFile(voiceoverFile)} volume={volume} />}

      {/* ── Overlay layer: callouts, ripples, and badges for each step ── */}
      {steps.map((step, i) => (
        <AbsoluteFill key={step.id || i} style={{ pointerEvents: 'none' }}>
          {renderStepOverlays(step, frame)}
        </AbsoluteFill>
      ))}

      {/* ── Cross-dissolve on hard cuts ── */}
      <CrossDissolve frame={frame} cutFrames={cutFrames} />

    </AbsoluteFill>
  );
};

module.exports = { ScratchComposition };
