import type { SceneConfig } from "./captions/types";

/**
 * Returns the video start frame for a scene (within the recording file),
 * accounting for startOffset trim.
 */
export const getVideoStartFrame = (scene: SceneConfig, fps: number): number => {
  const base = Math.round((scene.videoStartMs / 1000) * fps);
  return base + (scene.startOffset || 0);
};

/**
 * Returns the video end frame for a scene (within the recording file),
 * accounting for endOffset trim.
 */
export const getVideoEndFrame = (scene: SceneConfig, fps: number): number => {
  const base = Math.round((scene.videoEndMs / 1000) * fps);
  return base - (scene.endOffset || 0);
};

/**
 * Returns the trimmed duration in frames for a scene (what gets rendered in
 * the Sequence).
 */
export const getSceneDurationFrames = (
  scene: SceneConfig,
  fps: number
): number => {
  const raw = Math.round(((scene.videoEndMs - scene.videoStartMs) / 1000) * fps);
  const trimmed = raw - (scene.startOffset || 0) - (scene.endOffset || 0);
  return Math.max(1, trimmed);
};
