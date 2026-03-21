export interface Word {
  word: string;
  /** Start time in seconds within the full voiceover */
  start: number;
  /** End time in seconds */
  end: number;
  confidence?: number;
}

export interface Captions {
  words: Word[];
}

export interface SceneConfig {
  id: string;
  label: string;
  narration: string;
  durationMs: number;
  /** Start time (ms) in the processed recording video */
  videoStartMs: number;
  /** End time (ms) in the processed recording video */
  videoEndMs: number;
  /** Start time (ms) in the voiceover audio */
  audioStartMs: number;
  /** End time (ms) in the voiceover audio */
  audioEndMs: number;
  /** Frames to trim from the visual start of this scene (default 0) */
  startOffset: number;
  /** Frames to trim from the visual end of this scene (default 0) */
  endOffset: number;
}

export interface AdapterConfig {
  runId: string;
  recordingFile: string;
  voiceoverFile: string;
  captionsFile: string;
  fps: number;
  steps: SceneConfig[];
}
