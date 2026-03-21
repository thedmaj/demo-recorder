import React, { useCallback, useState } from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Audio,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
  getRemotionEnvironment,
} from "remotion";
import type { AdapterConfig, Captions, SceneConfig } from "./captions/types";
import { CaptionsEditor } from "./captions/CaptionsEditor";
import { DeleteRecordingAction } from "./DeleteRecordingAction";
import { getVideoStartFrame } from "./get-start-end-frame";

interface TrimHandleProps {
  side: "left" | "right";
  value: number;
  onChange: (delta: number) => void;
}

const TrimHandle: React.FC<TrimHandleProps> = ({ side, value, onChange }) => {
  const [dragging, setDragging] = useState(false);
  const [startX, setStartX] = useState(0);

  const handleMouseDown = (e: React.MouseEvent) => {
    setDragging(true);
    setStartX(e.clientX);
    e.preventDefault();

    const onMouseMove = (ev: MouseEvent) => {
      const delta = Math.round((ev.clientX - startX) / 5);
      const signed = side === "left" ? delta : -delta;
      if (signed !== 0) onChange(signed);
    };
    const onMouseUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const style: React.CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    [side]: 0,
    width: 14,
    background: dragging ? "#00A67E" : "rgba(0,166,126,0.65)",
    cursor: "ew-resize",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
    transition: "background 0.15s",
  };

  return (
    <div style={style} onMouseDown={handleMouseDown} title={`Trim ${side} (${value}f)`}>
      <span
        style={{
          color: "#fff",
          fontSize: 10,
          fontWeight: 700,
          writingMode: "vertical-rl",
          transform: "rotate(180deg)",
          userSelect: "none",
        }}
      >
        {value}f
      </span>
    </div>
  );
};

interface VideoSceneProps {
  scene: SceneConfig;
  config: AdapterConfig;
  captions: Captions | null;
  onConfigChange: (updated: AdapterConfig) => void;
  onCaptionsChange: (updated: Captions) => void;
}

export const VideoScene: React.FC<VideoSceneProps> = ({
  scene,
  config,
  captions,
  onConfigChange,
  onCaptionsChange,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const { isStudio } = getRemotionEnvironment();

  // Video starts from the scene's position in the recording, plus startOffset
  const videoStartFrame = getVideoStartFrame(scene, fps);

  const handleTrimChange = useCallback(
    async (side: "startOffset" | "endOffset", delta: number) => {
      const current = scene[side] || 0;
      const newVal = Math.max(0, current + delta);
      const updated: AdapterConfig = {
        ...config,
        steps: config.steps.map((s) =>
          s.id === scene.id ? { ...s, [side]: newVal } : s
        ),
      };
      onConfigChange(updated);

      try {
        const { writeStaticFile, saveDefaultProps } = await import(
          "@remotion/studio"
        );
        await writeStaticFile({
          filePath: "adapter-config.json",
          contents: JSON.stringify(updated, null, 2),
        });
        await saveDefaultProps({
          compositionId: "EvalDemo",
          defaultProps: updated,
        });
      } catch (err) {
        console.error("Failed to save trim:", err);
      }
    },
    [scene, config, onConfigChange]
  );

  // Voiceover audio for this scene
  const audioStartS = scene.audioStartMs / 1000;

  // Scene label overlay (top bar in Studio)
  const labelBar: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 36,
    background: "rgba(0,0,0,0.75)",
    backdropFilter: "blur(8px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    zIndex: 20,
    fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  };

  return (
    <AbsoluteFill>
      {/* Recording video — sliced to this scene's time range */}
      <OffthreadVideo
        src={staticFile(config.recordingFile)}
        startFrom={videoStartFrame}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* Voiceover audio — starts at this scene's position */}
      {config.voiceoverFile && (
        <Audio
          src={staticFile(config.voiceoverFile)}
          startFrom={Math.round(audioStartS * fps)}
        />
      )}

      {/* Studio-only overlays */}
      {isStudio && (
        <>
          {/* Scene label + delete action */}
          <div style={labelBar}>
            <span
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.7)",
                fontWeight: 500,
              }}
            >
              {scene.label}
            </span>
            <DeleteRecordingAction
              scene={scene}
              config={config}
              onConfigChange={onConfigChange}
            />
          </div>

          {/* Trim handles */}
          <TrimHandle
            side="left"
            value={scene.startOffset || 0}
            onChange={(d) => handleTrimChange("startOffset", d)}
          />
          <TrimHandle
            side="right"
            value={scene.endOffset || 0}
            onChange={(d) => handleTrimChange("endOffset", d)}
          />

          {/* Caption editor */}
          {captions && (
            <CaptionsEditor
              captions={captions}
              captionsFile={config.captionsFile}
              sceneStartS={scene.audioStartMs / 1000}
              onCaptionsChange={onCaptionsChange}
            />
          )}
        </>
      )}
    </AbsoluteFill>
  );
};
