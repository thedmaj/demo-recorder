import React from "react";
import { Composition } from "remotion";
import { Main } from "./Main";
import type { AdapterConfig } from "./captions/types";
import { getSceneDurationFrames } from "./get-start-end-frame";

/** Fallback config shown when no adapter-config.json props are passed */
const EMPTY_CONFIG: AdapterConfig = {
  runId: "none",
  recordingFile: "recording.mp4",
  voiceoverFile: "voiceover.mp3",
  captionsFile: "captions.json",
  fps: 30,
  steps: [],
};

/** Compute total duration from config */
const getTotalFrames = (config: AdapterConfig): number => {
  const fps = config.fps || 30;
  const total = config.steps.reduce(
    (acc, step) => acc + getSceneDurationFrames(step, fps),
    0
  );
  return Math.max(total, 1);
};

export const EvalRoot: React.FC = () => {
  return (
    <Composition
      id="EvalDemo"
      component={Main}
      durationInFrames={getTotalFrames(EMPTY_CONFIG)}
      fps={30}
      width={1440}
      height={900}
      defaultProps={{ config: EMPTY_CONFIG }}
      calculateMetadata={({ props }) => {
        const config = (props as { config: AdapterConfig }).config;
        const fps = config.fps || 30;
        return {
          durationInFrames: getTotalFrames(config),
          fps,
          width: 1440,
          height: 900,
          props: { config },
        };
      }}
    />
  );
};
