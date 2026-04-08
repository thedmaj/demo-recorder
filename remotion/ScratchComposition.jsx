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
  useRemotionEnvironment,
} = require('remotion');
const { useMemo } = require('react');

// ── @remotion/transitions — standardized scene transition library ──────────────
// TransitionSeries: wraps sequential scenes with animated transitions between them.
// Used in SceneTransition (type='fade') for library-standard fade-in behaviour.
const { TransitionSeries, linearTiming } = require('@remotion/transitions');
const { fade } = require('@remotion/transitions/fade');

// ── Design tokens ──────────────────────────────────────────────────────────────
const PLAID_BLACK = '#0d1117';
const PLAID_WHITE = '#ffffff';
const PLAID_TEAL  = '#00A67E';
const FONT_STACK  = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

// Ensure interpolate() input ranges are strictly increasing, even on short steps.
function strictlyIncreasingRange(values, minStep = 0.001) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const n = Number(values[i] ?? 0);
    if (!Number.isFinite(n)) {
      out.push(i === 0 ? 0 : out[i - 1] + minStep);
      continue;
    }
    if (i === 0) {
      out.push(n);
    } else {
      out.push(Math.max(n, out[i - 1] + minStep));
    }
  }
  return out;
}

// ── Cut definition ────────────────────────────────────────────────────────────
// Set to past end-of-video to effectively disable the Remotion-level cut.
// All editing is handled by ffmpeg in post-process-recording.js. The sync map
// below handles any remaining speed/freeze adjustments within Remotion.
const CUT_START_S    = 32.567;  // comp frame 977 — start of removed range
const CUT_END_S      = 48.233;  // comp frame 1447 — first frame after removed range (977–1446 inclusive, 470 frames)

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

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATION TOOLKIT
// ═══════════════════════════════════════════════════════════════════════════════

// ── useSpring — spring value starting from a given frame ──────────────────────
// Returns a spring that starts at `atFrame` and settles to 1.0.
// offset: add a constant to the settled value (e.g. offset=1 → value goes 1→2).
//
//   const scale = useSpring(relFrame, fps, { offset: 1 }); // 1.0 → 2.0
//   const opacity = useSpring(relFrame, fps);               // 0.0 → 1.0
function useSpring(frame, fps, {
  atFrame   = 0,
  damping   = 14,
  stiffness = 120,
  mass      = 1,
  offset    = 0,    // added to the spring value (spring settles at 1+offset)
} = {}) {
  const local  = frame - atFrame;
  if (local < 0) return offset;          // before atFrame: return offset (= 0+offset)
  const value1 = spring({ frame: local, fps, config: { damping, stiffness, mass } });
  const value2 = offset;                 // exactly the pattern you shared: value1 + value2
  return value1 + value2;               // total: offset → 1+offset
}

// ── useSpringScale — spring scale starting at 1 ───────────────────────────────
// Convenience: like useSpring(offset=1) but named for clarity.
//   const scale = useSpringScale(relFrame, fps); // 1.0 → 2.0
//   const scale = useSpringScale(relFrame, fps, { target: 1.08 }); // 1.0 → 1.08
function useSpringScale(frame, fps, { atFrame = 0, target = 2, damping = 14, stiffness = 120, mass = 1 } = {}) {
  const local = frame - atFrame;
  if (local < 0) return 1;
  // spring goes 0→1; map to 1→target
  const t = spring({ frame: local, fps, config: { damping, stiffness, mass } });
  return 1 + t * (target - 1);
}

// ── SceneTransition — spring-powered enter/exit for any scene content ─────────
// Wraps children with a configurable spring entrance.
//   type: 'fade-up' | 'fade-down' | 'fade-left' | 'fade-right' | 'scale' | 'fade'
//
// The 'fade' type uses @remotion/transitions TransitionSeries + fade() presentation
// for library-standard fade-in behaviour. All other types use custom spring animations.
//
// Usage in a step:
//   <SceneTransition relFrame={relFrame} fps={fps} durationFrames={durationFrames} type="fade-up">
//     <MyContent />
//   </SceneTransition>
//
//   <SceneTransition durationFrames={durationFrames} type="fade">
//     <MyContent />    {/* no relFrame/fps needed for library fade */}
//   </SceneTransition>

const SCENE_FADE_FRAMES = 18; // duration of @remotion/transitions fade (approx 0.6s at 30fps)

/**
 * SceneTransitionFade — uses @remotion/transitions' fade() presentation.
 * Renders via a minimal TransitionSeries (empty → content) so the library
 * handles easing internally. Parent Sequence provides the absolute frame offset.
 */
function SceneTransitionFade({ durationFrames, children }) {
  return (
    <TransitionSeries>
      {/* Empty "before" scene; its end overlaps with the fade-in of the content scene */}
      <TransitionSeries.Sequence durationInFrames={SCENE_FADE_FRAMES}>
        <AbsoluteFill style={{ pointerEvents: 'none' }} />
      </TransitionSeries.Sequence>

      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: SCENE_FADE_FRAMES })}
      />

      <TransitionSeries.Sequence durationInFrames={durationFrames}>
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          {children}
        </AbsoluteFill>
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
}

function SceneTransition({ relFrame, fps, durationFrames, type = 'fade-up', atFrame = 0, exitFrames = 15, children }) {
  // Always call hooks unconditionally (React rules)
  const enterSpring = useSpring(relFrame, fps, { atFrame, damping: 16, stiffness: 140 });
  const transitionRange = strictlyIncreasingRange([atFrame, atFrame + 12, durationFrames - exitFrames, durationFrames]);
  const opacity = interpolate(
    relFrame,
    transitionRange,
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // 'fade' type: delegate to library-standard fade via @remotion/transitions
  if (type === 'fade') {
    return <SceneTransitionFade durationFrames={durationFrames}>{children}</SceneTransitionFade>;
  }

  let transform = '';
  if (type === 'fade-up')    transform = `translateY(${interpolate(enterSpring, [0, 1], [40, 0])}px)`;
  if (type === 'fade-down')  transform = `translateY(${interpolate(enterSpring, [0, 1], [-40, 0])}px)`;
  if (type === 'fade-left')  transform = `translateX(${interpolate(enterSpring, [0, 1], [60, 0])}px)`;
  if (type === 'fade-right') transform = `translateX(${interpolate(enterSpring, [0, 1], [-60, 0])}px)`;
  if (type === 'scale')      transform = `scale(${useSpringScale(relFrame, fps, { atFrame, target: 1, damping: 18, stiffness: 160 })})`;

  return (
    <div style={{ opacity, transform, pointerEvents: 'none' }}>
      {children}
    </div>
  );
}

// ── SplitMarker — visual marker at a specific video time for debug/review ─────
// Renders a labelled teal bar at a given composition second (visible in Studio only).
//   <SplitMarker atSecond={13.0} label="Plaid Link start" frame={frame} fps={fps} />
function SplitMarker({ atSecond, label, frame, fps }) {
  const { isStudio } = useRemotionEnvironment();
  if (!isStudio) return null;                          // never appears in final render
  const atF    = Math.round(atSecond * fps);
  const dist   = Math.abs(frame - atF);
  if (dist > fps * 0.5) return null;                  // visible ±0.5s around the mark
  const opacity = interpolate(dist, [0, fps * 0.4], [1, 0], { extrapolateRight: 'clamp' });
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0,
      height: 4, background: PLAID_TEAL, opacity,
      boxShadow: `0 0 12px ${PLAID_TEAL}`,
      pointerEvents: 'none', zIndex: 9999,
    }}>
      {label && (
        <div style={{
          position: 'absolute', top: 6, left: 12,
          background: PLAID_TEAL, color: '#fff',
          fontSize: 11, fontFamily: FONT_STACK, fontWeight: 700,
          padding: '2px 8px', borderRadius: 4, whiteSpace: 'nowrap', opacity,
        }}>{label}</div>
      )}
    </div>
  );
}

// ── VideoSegmentOverlay — highlight a video time range in Studio ──────────────
// Tints the screen for a composition range. Studio-only.
//   <VideoSegmentOverlay fromS={13} toS={37} label="1.3× speed" color="rgba(0,166,126,0.12)" frame={frame} fps={fps} />
function VideoSegmentOverlay({ fromS, toS, label, color = 'rgba(0,166,126,0.08)', frame, fps }) {
  const { isStudio } = useRemotionEnvironment();
  if (!isStudio) return null;
  const fromF = Math.round(fromS * fps);
  const toF   = Math.round(toS   * fps);
  if (frame < fromF || frame >= toF) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: color, pointerEvents: 'none', zIndex: 9998,
    }}>
      {label && (
        <div style={{
          position: 'absolute', top: 12, right: 16,
          background: 'rgba(0,0,0,0.6)', color: PLAID_TEAL,
          fontSize: 11, fontFamily: FONT_STACK, fontWeight: 700,
          padding: '3px 10px', borderRadius: 4, border: `1px solid ${PLAID_TEAL}`,
        }}>{label}</div>
      )}
    </div>
  );
}

// ── Reusable fade helper ───────────────────────────────────────────────────────
function useFade(frame, inStart, inEnd, outStart, outEnd) {
  const range = strictlyIncreasingRange([inStart, inEnd, outStart, outEnd]);
  return interpolate(
    frame,
    range,
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOUSE TRAIL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pure helper — returns { xFrac, yFrac, opacity } of the virtual cursor at any
 * given frame, by spring-interpolating between consecutive click events.
 *
 * Safe to call N times per render (spring() is a pure function, not a hook).
 */
function getCursorPos(events, frame, fps) {
  if (!events || events.length === 0) return null;

  const first = events[0];
  const last  = events[events.length - 1];

  // Outside the visible window entirely
  if (frame < first.atFrame - 24 || frame > last.stepEndF + 20) return null;

  // Locate the segment: previous click (already happened) + next click (upcoming)
  let prev = null;
  let next = null;
  for (let i = 0; i < events.length; i++) {
    if (frame >= events[i].atFrame) prev = events[i];
    else { next = events[i]; break; }
  }

  let xFrac, yFrac, opacity;

  if (!prev) {
    // Approaching first click from above-screen
    const t = interpolate(frame, [first.atFrame - 24, first.atFrame], [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    xFrac = first.xFrac;  yFrac = first.yFrac;  opacity = t;
  } else if (!next) {
    // After last click — hold position, then fade at step end
    const fadeStart = prev.atFrame + 20;
    const fadeRange = strictlyIncreasingRange([fadeStart, last.stepEndF]);
    xFrac = prev.xFrac;  yFrac = prev.yFrac;
    opacity = interpolate(frame, fadeRange,
      [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  } else {
    // Moving: spring from prev click position toward next click position
    const elapsed = Math.max(0, frame - prev.atFrame);
    const t = Math.min(1, spring({ frame: elapsed, fps,
      config: { damping: 22, stiffness: 70, mass: 1.2 } }));
    xFrac = prev.xFrac + (next.xFrac - prev.xFrac) * t;
    yFrac = prev.yFrac + (next.yFrac - prev.yFrac) * t;
    opacity = 1;
  }

  return { xFrac, yFrac, opacity: Math.max(0, Math.min(1, opacity)) };
}

/**
 * MouseTrail — ghost cursor that smoothly travels between click positions.
 *
 * Renders:
 *   • Outer ring + inner dot cursor at current position
 *   • TRAIL_LEN ghost dots trailing behind, fading and shrinking with distance
 *
 * Enabled automatically for any step with a `clickRipple`.
 * Disable per-step with `"mouseTrail": false` in demo-script.json.
 */
function MouseTrail({ steps, frame, fps }) {
  const events = useMemo(() => (steps || [])
    .filter(s => s.clickRipple && s.mouseTrail !== false)
    .map(s => ({
      xFrac:    s.clickRipple.xFrac,
      yFrac:    s.clickRipple.yFrac,
      atFrame:  (s.startFrame ?? 0) + (s.clickRipple.atFrame ?? 15),
      stepEndF: s.endFrame ?? (s.startFrame ?? 0) + 300,
    }))
    .sort((a, b) => a.atFrame - b.atFrame),
  [steps]);

  if (events.length < 1) return null;

  const cur = getCursorPos(events, frame, fps);
  if (!cur || cur.opacity <= 0.01) return null;

  const TRAIL_LEN   = 7;
  const TRAIL_DELAY = 4;   // frames between each ghost dot
  const CURSOR_R    = 14;  // outer ring radius (comp pixels)

  const trailDots = [];
  for (let i = 1; i <= TRAIL_LEN; i++) {
    const past = getCursorPos(events, frame - i * TRAIL_DELAY, fps);
    if (!past || past.opacity <= 0.01) continue;

    const trailOpacity = cur.opacity * interpolate(i, [1, TRAIL_LEN + 1], [0.45, 0.03]);
    const trailR       = interpolate(i, [1, TRAIL_LEN + 1], [10, 4]);

    trailDots.push(
      <div key={i} style={{
        position:      'absolute',
        left:          `${past.xFrac * 100}%`,
        top:           `${past.yFrac * 100}%`,
        width:          trailR * 2,
        height:         trailR * 2,
        borderRadius:   '50%',
        background:     PLAID_TEAL,
        transform:      'translate(-50%, -50%)',
        opacity:        trailOpacity,
        pointerEvents: 'none',
      }} />
    );
  }

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {trailDots}

      {/* Cursor: outer ring */}
      <div style={{
        position:     'absolute',
        left:         `${cur.xFrac * 100}%`,
        top:          `${cur.yFrac * 100}%`,
        width:         CURSOR_R * 2,
        height:        CURSOR_R * 2,
        borderRadius:  '50%',
        border:        `2.5px solid ${PLAID_TEAL}`,
        transform:     'translate(-50%, -50%)',
        opacity:        cur.opacity * 0.9,
        pointerEvents: 'none',
        boxShadow:     `0 0 8px rgba(0,166,126,0.5)`,
      }} />

      {/* Cursor: inner dot */}
      <div style={{
        position:     'absolute',
        left:         `${cur.xFrac * 100}%`,
        top:          `${cur.yFrac * 100}%`,
        width:         7,
        height:        7,
        borderRadius:  '50%',
        background:    PLAID_TEAL,
        transform:     'translate(-50%, -50%)',
        opacity:        cur.opacity,
        pointerEvents: 'none',
        boxShadow:     `0 0 4px rgba(0,166,126,0.8)`,
      }} />
    </AbsoluteFill>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTLIGHT PULSE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SpotlightPulse — radial vignette that focuses attention on the active click target.
 *
 * Renders a dark overlay with a transparent "spotlight hole" around the target:
 *   • Springs in at step start (hole grows from 0 to full radius)
 *   • Gently oscillates (±18px) using sin wave — feels alive, not static
 *   • Smoothly crossfades between steps (no hard cut)
 *   • Fades out at step end
 *
 * Config per step in demo-script.json:
 *   "spotlight": { "xFrac": 0.5, "yFrac": 0.5, "radius": 300, "intensity": 0.55 }
 *   OR auto-derived from clickRipple (default).
 *   Disable per-step with "spotlight": false.
 *
 * Radius and position are in composition pixel space (2880×1800).
 */
function SpotlightPulse({ steps, frame, fps }) {
  // Collect steps that have spotlight active
  const targets = useMemo(() => (steps || [])
    .filter(s => s.spotlight !== false && (s.spotlight || s.clickRipple))
    .map(s => {
      const cfg = (typeof s.spotlight === 'object' && s.spotlight) || {};
      return {
        xFrac:     cfg.xFrac     ?? s.clickRipple?.xFrac     ?? 0.5,
        yFrac:     cfg.yFrac     ?? s.clickRipple?.yFrac     ?? 0.5,
        radius:    cfg.radius    ?? 300,
        intensity: cfg.intensity ?? 0.52,
        startF:    s.startFrame ?? 0,
        endF:      s.endFrame   ?? (s.startFrame ?? 0) + 300,
      };
    }),
  [steps]);

  if (targets.length === 0) return null;

  // Find the active target at this frame
  const active = targets.find(t => frame >= t.startF && frame < t.endF);
  if (!active) return null;

  const relFrame  = frame - active.startF;
  const durFrames = active.endF - active.startF;

  // Spring entrance (0→1 over ~20 frames)
  const enterT = Math.min(1, spring({ frame: relFrame, fps,
    config: { damping: 20, stiffness: 90, mass: 1 } }));

  // Gentle heartbeat pulse — sin wave, period ~50 frames (~1.7s at 30fps)
  const pulse = Math.sin(relFrame * 0.125) * 18;

  // Fade out over last 20 frames of step
  const fadeRange = strictlyIncreasingRange([0, 10, durFrames - 20, durFrames]);
  const fadeOpacity = interpolate(relFrame,
    fadeRange,
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const radius      = active.radius * enterT + pulse * enterT;
  const featherSize = 140;                           // gradient feather width
  const innerR      = Math.max(0, radius);
  const outerR      = innerR + featherSize;
  const intensity   = active.intensity * fadeOpacity;

  const xPct = active.xFrac * 100;
  const yPct = active.yFrac * 100;

  return (
    <AbsoluteFill style={{
      background:     `radial-gradient(circle at ${xPct}% ${yPct}%, transparent ${innerR}px, rgba(0,0,0,${intensity.toFixed(3)}) ${outerR}px)`,
      pointerEvents: 'none',
    }} />
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

  const zoomRange = strictlyIncreasingRange([startFrame, punchIn, peakFrame, punchOut, endFrame]);
  const scale = interpolate(
    frame,
    zoomRange,
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

function SyncedVideo({ src, videoStyle, zoomStep, frame, fps, cutStartF, cutEndF, totalFrames, segments }) {

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
  const { isStudio } = useRemotionEnvironment();

  const cutStartF = Math.round(CUT_START_S * fps);
  const cutEndF   = Math.round(CUT_END_S   * fps);

  // Studio uses 1440×900 H.264 preview (fast scrubbing); render uses full 2880×1800.
  const videoSrc = isStudio ? 'recording-studio.mp4' : 'recording.mp4';

  // Memoize sync segments — only rebuilds when fps/cut/syncMap change, not every frame.
  const segments = useMemo(
    () => buildSyncSegments(fps, cutStartF, cutEndF, durationInFrames, syncMap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fps, cutStartF, cutEndF, durationInFrames, syncMap.length]
  );

  // Find the step that has a zoomPunch active at this frame
  const zoomStep = steps.find(s =>
    s.zoomPunch &&
    frame >= (s.startFrame ?? 0) &&
    frame < (s.endFrame ?? (s.startFrame ?? 0) + 300)
  );

  // Memoize click frames — only rebuilds when steps change, not every frame.
  const clickFrames = useMemo(
    () => steps
      .filter(s => s.clickRipple)
      .map(s => (s.startFrame ?? 0) + (s.clickRipple.atFrame ?? 15)),
    [steps]
  );

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
        src={videoSrc}
        videoStyle={videoStyle}
        zoomStep={zoomStep}
        frame={frame}
        fps={fps}
        cutStartF={cutStartF}
        cutEndF={cutEndF}
        totalFrames={durationInFrames}
        segments={segments}
      />

      {/* ── Voiceover audio (plays continuously, unaffected by video cut) ── */}
      {hasVoiceover && <Audio src={staticFile(voiceoverFile)} volume={volume} />}

      {/* ── Spotlight vignette — behind cursor trail and callouts ── */}
      <SpotlightPulse steps={steps} frame={frame} fps={fps} />

      {/* ── Mouse trail — above spotlight, below callouts ── */}
      <MouseTrail steps={steps} frame={frame} fps={fps} />

      {/* ── Overlay layer: each step's overlays are scoped to its Sequence window ── */}
      {steps.map((step, i) => {
        const sf = step.startFrame ?? 0;
        const ef = step.endFrame ?? sf + 300;
        if (ef <= sf) return null;
        return (
          <Sequence key={step.id || i} from={sf} durationInFrames={ef - sf}>
            <AbsoluteFill style={{ pointerEvents: 'none' }}>
              {renderStepOverlays(step, frame)}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* ── Cross-dissolve on hard cuts ── */}
      <CrossDissolve frame={frame} cutFrames={cutFrames} />

      {/* ── Studio-only: sync map segment overlays + split markers ── */}
      {syncMap.map((seg, i) => (
        <VideoSegmentOverlay
          key={`seg-${i}`}
          fromS={seg.compStart}
          toS={seg.compEnd}
          label={seg.mode === 'freeze' ? '⏸ freeze' : seg.mode === 'speed' ? `${seg.speed ?? 1}× speed` : null}
          color={seg.mode === 'freeze' ? 'rgba(251,191,36,0.08)' : seg.mode === 'speed' ? 'rgba(0,166,126,0.08)' : null}
          frame={frame}
          fps={fps}
        />
      ))}
      {syncMap.map((seg, i) => (
        <SplitMarker key={`split-${i}`} atSecond={seg.compStart} label={i === 0 ? `cut ${i + 1}` : null} frame={frame} fps={fps} />
      ))}

    </AbsoluteFill>
  );
};

module.exports = { ScratchComposition };
