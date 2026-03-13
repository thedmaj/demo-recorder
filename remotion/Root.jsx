const { Composition, getInputProps } = require('remotion');
const { DemoComposition }    = require('./DemoComposition');
const { ScratchComposition } = require('./ScratchComposition');
const { EnhanceComposition } = require('./EnhanceComposition');

/**
 * Root.jsx
 * Registers all Remotion compositions.
 *
 * Data loading note: Remotion runs in webpack (browser context) — Node's `fs`
 * is unavailable. Instead, the orchestrator pre-generates a props file at
 * out/remotion-props.json and passes it via `--props` on the render CLI.
 * At design-time (Studio), compositions use sensible defaults.
 */

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
    <Composition
      id="DemoScratch"
      component={ScratchComposition}
      durationInFrames={scratchDurationFrames}
      fps={30}
      width={2880}
      height={1800}
      defaultProps={{ steps: scratchSteps, voiceoverFile: 'voiceover.mp3', hasVoiceover: scratchHasVoiceover, syncMap: scratchSyncMap }}
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
