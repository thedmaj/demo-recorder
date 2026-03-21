const { Composition, getInputProps } = require('remotion');
const { z }                          = require('zod');
const { DemoComposition }            = require('./DemoComposition');
const { ScratchComposition }         = require('./ScratchComposition');
const { EnhanceComposition }         = require('./EnhanceComposition');

/**
 * Root.jsx
 * Registers all Remotion compositions.
 *
 * Data loading note: Remotion runs in webpack (browser context) — Node's `fs`
 * is unavailable. Instead, the orchestrator pre-generates a props file at
 * out/remotion-props.json and passes it via `--props` on the render CLI.
 * At design-time (Studio), compositions use sensible defaults and the Zod
 * schemas below drive the interactive prop editor (Cmd+J in Studio).
 */

// ── Zod schemas (B2) — enable Studio prop editor knobs ──────────────────────

const SyncSegmentSchema = z.object({
  compStart:  z.number().describe('Composition start (seconds)'),
  compEnd:    z.number().describe('Composition end (seconds)'),
  videoStart: z.number().describe('Video source start (seconds)'),
  mode:       z.enum(['speed', 'freeze', 'normal']),
  speed:      z.number().optional().describe('Playback multiplier (speed mode only)'),
});

const ClickRippleSchema = z.object({
  xFrac:   z.number().min(0).max(1).describe('Click X position (0–1 fraction of viewport)'),
  yFrac:   z.number().min(0).max(1).describe('Click Y position (0–1 fraction of viewport)'),
  atFrame: z.number().int().describe('Frame offset within the step to show the ripple'),
});

const ZoomPunchSchema = z.union([
  z.boolean(),
  z.object({
    scale:    z.number().min(1).max(2).describe('Zoom scale factor (1.0 = no zoom)'),
    peakFrac: z.number().min(0).max(1).describe('Fraction of step duration at peak zoom'),
    originX:  z.string().optional().describe('CSS transform-origin X (e.g. "50%" or "720px")'),
    originY:  z.string().optional().describe('CSS transform-origin Y'),
  }),
]);

const CalloutSchema = z.object({
  type:     z.enum(['lower-third', 'stat-counter', 'badge']),
  title:    z.string().optional(),
  subtext:  z.string().optional(),
  value:    z.number().optional().describe('Numeric value for stat-counter'),
  suffix:   z.string().optional().describe('Unit suffix for stat-counter (e.g. "%", "s")'),
  label:    z.string().optional(),
  position: z.string().optional().describe('Overlay position (e.g. "stat-1", "top-right")'),
});

const StepSchema = z.object({
  id:            z.string(),
  label:         z.string(),
  startMs:       z.number(),
  endMs:         z.number(),
  durationMs:    z.number(),
  startFrame:    z.number().int(),
  endFrame:      z.number().int(),
  durationFrames: z.number().int(),
  narration:     z.string().optional(),
  clickRipple:   ClickRippleSchema.optional(),
  zoomPunch:     ZoomPunchSchema.optional(),
  callouts:      z.array(CalloutSchema).optional(),
});

const ScratchPropsSchema = z.object({
  steps:        z.array(StepSchema).describe('Per-step timing, overlays, and narration'),
  hasVoiceover: z.boolean().describe('Whether voiceover.mp3 is available'),
  syncMap:      z.array(SyncSegmentSchema).describe('Speed/freeze window definitions'),
});

// ── Default values (used when Studio opens without --props) ─────────────────
const defaults = {
  scratchDurationFrames: 4500,
  scratchSteps: [],
  enhanceDurationFrames: 4500,
  enhanceOverlayPlan: { zoomPunches: [], callouts: [], lowerThirds: [], highlights: [] },
  enhanceTotalMs: 150000,
};

// ── Merge with CLI props if provided ────────────────────────────────────────
const inputProps = getInputProps() || {};

const scratchDurationFrames = inputProps.scratchDurationFrames || defaults.scratchDurationFrames;
const scratchSteps          = inputProps.scratchSteps          || defaults.scratchSteps;
const scratchHasVoiceover   = inputProps.hasVoiceover !== undefined ? inputProps.hasVoiceover : true;
const scratchSyncMap        = inputProps.syncMap               || [];
const enhanceDurationFrames = inputProps.enhanceDurationFrames || defaults.enhanceDurationFrames;
const enhanceOverlayPlan    = inputProps.enhanceOverlayPlan    || defaults.enhanceOverlayPlan;
const enhanceTotalMs        = inputProps.enhanceTotalMs        || defaults.enhanceTotalMs;

// ── Root ────────────────────────────────────────────────────────────────────
const Root = () => (
  <>
    {/* ── Existing Demo composition (unchanged) ── */}
    <Composition
      id="Demo"
      component={DemoComposition}
      durationInFrames={3400}
      fps={30}
      width={1920}
      height={1080}
    />

    {/* ── Mode A: Claude-built app + voiceover ── */}
    {/* calculateMetadata (B3): composition duration updates live in Studio when step endFrame changes */}
    <Composition
      id="DemoScratch"
      component={ScratchComposition}
      durationInFrames={scratchDurationFrames}
      fps={30}
      width={2880}
      height={1800}
      defaultProps={{ steps: scratchSteps, hasVoiceover: scratchHasVoiceover, syncMap: scratchSyncMap }}
      schema={ScratchPropsSchema}
      calculateMetadata={({ props }) => {
        const steps = props.steps || [];
        const last  = steps[steps.length - 1];
        const fromSteps = last ? last.endFrame + 60 : 4500;
        // scratchDurationFrames (passed via --props) accounts for freeze extensions beyond the
        // last step's endFrame — use whichever is larger so freeze-heavy compositions render fully.
        const durationInFrames = Math.max(fromSteps, scratchDurationFrames);
        return { durationInFrames };
      }}
    />

    {/* ── Mode B/C: User recording enhanced with AI overlays ── */}
    <Composition
      id="DemoEnhance"
      component={EnhanceComposition}
      durationInFrames={enhanceDurationFrames}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ overlayPlan: enhanceOverlayPlan, totalDurationMs: enhanceTotalMs }}
    />
  </>
);

module.exports = { Root };
