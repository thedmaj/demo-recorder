/**
 * EnhanceComposition.jsx
 * Remotion composition for Mode B/C.
 * Base: original user recording (original audio muted)
 * Audio: ElevenLabs replacement voice
 * Overlays: driven by out/overlay-plan.json (zoom, callouts, lower-thirds, highlights)
 */

const {
  AbsoluteFill,
  OffthreadVideo,
  Audio,
  staticFile,
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

// Ensure interpolate() input ranges are strictly increasing, even for short windows.
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

// ── Helper: milliseconds to frame number ──────────────────────────────────────
function msToFrame(ms, fps) {
  return Math.round(ms / 1000 * fps);
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

// ── Zoom punch state computation ──────────────────────────────────────────────
//
// Returns { scale, translateX, translateY } for the current frame.
// If no zoomPunch is active, scale = 1, translates = 0.
//
function computeZoom(zoomPunches, frame, fps, width, height) {
  if (!zoomPunches || zoomPunches.length === 0) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }

  const active = zoomPunches.find(zp => {
    const startF = msToFrame(zp.startMs, fps);
    const endF   = msToFrame(zp.endMs,   fps);
    return frame >= startF && frame < endF;
  });

  if (!active) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }

  const startF    = msToFrame(active.startMs, fps);
  const endF      = msToFrame(active.endMs,   fps);
  const rampFrames = Math.min(15, Math.floor((endF - startF) * 0.2));
  const targetScale = active.scale || 1.15;

  const zoomRange = strictlyIncreasingRange([startF, startF + rampFrames, endF - rampFrames, endF]);
  const scale = interpolate(
    frame,
    zoomRange,
    [1.0, targetScale, targetScale, 1.0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  // Compute translation to keep the zoom centered on the target region
  let originX = 0.5; // 0–1 normalized
  let originY = 0.5;

  switch (active.target) {
    case 'top-left':     originX = 0.25; originY = 0.25; break;
    case 'top-right':    originX = 0.75; originY = 0.25; break;
    case 'top-center':   originX = 0.5;  originY = 0.2;  break;
    case 'bottom-left':  originX = 0.25; originY = 0.75; break;
    case 'bottom-right': originX = 0.75; originY = 0.75; break;
    case 'center':
    default:             originX = 0.5;  originY = 0.5;  break;
  }

  // If explicit pixel coordinates provided, use those
  if (active.x != null && active.y != null) {
    originX = active.x / width;
    originY = active.y / height;
  }

  // When scaling around an off-center origin, we need to translate
  // so the origin point stays fixed visually.
  const translateX = (0.5 - originX) * width  * (scale - 1);
  const translateY = (0.5 - originY) * height * (scale - 1);

  return { scale, translateX, translateY };
}

// ── Callout rendering ─────────────────────────────────────────────────────────
function renderCallouts(callouts, frame, fps) {
  if (!callouts || callouts.length === 0) return null;

  return callouts.map((callout, i) => {
    const startF = msToFrame(callout.startMs, fps);
    const endF   = msToFrame(callout.endMs,   fps);

    if (frame < startF || frame >= endF) return null;

    const relFrame     = frame - startF;
    const durationFrames = endF - startF;

    const { fps: _fps } = { fps }; // capture for spring
    const scaleVal = spring({
      frame: relFrame,
      fps,
      config: { damping: 14, stiffness: 120, mass: 0.8 },
    });

    const opacity = useFade(relFrame, 0, 12, durationFrames - 15, durationFrames - 3);
    const translateY = interpolate(relFrame, [0, 12], [20, 0], { extrapolateRight: 'clamp' });

    const positionStyle = resolvePosition(callout.position || 'top-right');

    return (
      <div
        key={`callout-${i}`}
        style={{
          position: 'absolute',
          ...positionStyle,
          opacity,
          transform: `scale(${scaleVal}) translateY(${translateY}px)`,
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
          maxWidth: 340,
        }}
      >
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
  });
}

// ── Lower-third rendering ─────────────────────────────────────────────────────
function renderLowerThirds(lowerThirds, frame, fps) {
  if (!lowerThirds || lowerThirds.length === 0) return null;

  return lowerThirds.map((lt, i) => {
    const startF = msToFrame(lt.startMs, fps);
    const endF   = msToFrame(lt.endMs,   fps);

    if (frame < startF || frame >= endF) return null;

    const relFrame       = frame - startF;
    const durationFrames = endF - startF;

    const opacity = useFade(relFrame, 0, 15, durationFrames - 15, durationFrames - 3);
    const slideY  = interpolate(relFrame, [0, 18], [60, 0], { extrapolateRight: 'clamp' });

    return (
      <div
        key={`lower-third-${i}`}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '15%',
          opacity,
          transform: `translateY(${slideY}px)`,
          pointerEvents: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 48px',
        }}
      >
        <div style={{
          display: 'inline-flex',
          alignItems: 'stretch',
          background: 'rgba(13,17,23,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          borderRadius: 8,
          overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
        }}>
          {/* Teal accent bar on left */}
          <div style={{
            width: 4,
            background: PLAID_TEAL,
            flexShrink: 0,
          }} />
          <div style={{ padding: '10px 20px' }}>
            <div style={{
              color: PLAID_WHITE,
              fontFamily: FONT_STACK,
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: 0.2,
              lineHeight: 1.3,
            }}>
              {lt.title || lt.text}
            </div>
            {lt.subtext && (
              <div style={{
                color: 'rgba(255,255,255,0.6)',
                fontFamily: FONT_STACK,
                fontWeight: 400,
                fontSize: 12,
                marginTop: 3,
                lineHeight: 1.3,
              }}>
                {lt.subtext}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  });
}

// ── Highlight rendering ───────────────────────────────────────────────────────
function renderHighlights(highlights, frame, fps) {
  if (!highlights || highlights.length === 0) return null;

  return highlights.map((hl, i) => {
    const startF = msToFrame(hl.startMs, fps);
    const endF   = msToFrame(hl.endMs,   fps);

    if (frame < startF || frame >= endF) return null;

    const relFrame       = frame - startF;
    const durationFrames = endF - startF;

    const borderRange = strictlyIncreasingRange([0, 10, durationFrames - 10, durationFrames]);
    const borderOpacity = interpolate(
      relFrame,
      borderRange,
      [0, 1, 1, 0],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );

    // hl.area: { x, y, w, h } in pixels (absolute, relative to video frame)
    // or percentages if hl.area.unit === '%'
    const area = hl.area || {};
    const usePercent = area.unit === '%';

    const posStyle = usePercent ? {
      left:   `${area.x || 0}%`,
      top:    `${area.y || 0}%`,
      width:  `${area.w || 20}%`,
      height: `${area.h || 10}%`,
    } : {
      left:   area.x || 0,
      top:    area.y || 0,
      width:  area.w || 200,
      height: area.h || 60,
    };

    return (
      <div
        key={`highlight-${i}`}
        style={{
          position: 'absolute',
          ...posStyle,
          border: `2px solid ${PLAID_TEAL}`,
          borderRadius: 6,
          boxShadow: `0 0 12px rgba(0,166,126,${borderOpacity * 0.5})`,
          opacity: borderOpacity,
          pointerEvents: 'none',
          background: `rgba(0,166,126,${borderOpacity * 0.06})`,
        }}
      />
    );
  });
}

// ── Main composition ───────────────────────────────────────────────────────────
const EnhanceComposition = ({
  overlayPlan = { zoomPunches: [], callouts: [], lowerThirds: [], highlights: [] },
  totalDurationMs = 150000,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const zoomPunches  = overlayPlan.zoomPunches  || [];
  const callouts     = overlayPlan.callouts     || [];
  const lowerThirds  = overlayPlan.lowerThirds  || [];
  const highlights   = overlayPlan.highlights   || [];

  // Compute zoom state for this frame
  const { scale, translateX, translateY } = computeZoom(zoomPunches, frame, fps, width, height);

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: PLAID_BLACK }}>

      {/* ── Zoom punch wrapper around base video ── */}
      <AbsoluteFill style={{
        transform: `scale(${scale}) translateX(${translateX}px) translateY(${translateY}px)`,
        transformOrigin: 'center center',
      }}>
        {/* Base video — original audio silenced */}
        <OffthreadVideo
          src={staticFile('recording.webm')}
          volume={0}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </AbsoluteFill>

      {/* ── Replacement voiceover audio ── */}
      <Audio src={staticFile('voiceover.mp3')} volume={1} />

      {/* ── Callout overlays ── */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        {renderCallouts(callouts, frame, fps)}
      </AbsoluteFill>

      {/* ── Lower-third overlays ── */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        {renderLowerThirds(lowerThirds, frame, fps)}
      </AbsoluteFill>

      {/* ── Highlight overlays ── */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        {renderHighlights(highlights, frame, fps)}
      </AbsoluteFill>

    </AbsoluteFill>
  );
};

module.exports = { EnhanceComposition };
