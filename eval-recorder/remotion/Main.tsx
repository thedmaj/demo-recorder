import React, { useState, useEffect } from "react";
import {
  AbsoluteFill,
  Sequence,
  useVideoConfig,
  staticFile,
  getRemotionEnvironment,
} from "remotion";
import type { AdapterConfig, Captions } from "./captions/types";
import { VideoScene } from "./VideoScene";
import { getSceneDurationFrames } from "./get-start-end-frame";

interface MainProps {
  config: AdapterConfig;
}

export const Main: React.FC<MainProps> = ({ config }) => {
  const { fps } = useVideoConfig();
  const { isStudio } = getRemotionEnvironment();

  const [liveConfig, setLiveConfig] = useState<AdapterConfig>(config);
  const [captions, setCaptions] = useState<Captions | null>(null);

  // Load captions from static file
  useEffect(() => {
    if (!config.captionsFile) return;
    fetch(staticFile(config.captionsFile))
      .then((r) => r.json())
      .then(setCaptions)
      .catch(() => {
        console.warn("No captions file found:", config.captionsFile);
      });
  }, [config.captionsFile]);

  // Keep liveConfig in sync with incoming props (Studio reloads props on change)
  useEffect(() => {
    setLiveConfig(config);
  }, [config]);

  let sequenceOffset = 0;

  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {liveConfig.steps.map((scene) => {
        const durationInFrames = getSceneDurationFrames(scene, fps);
        const from = sequenceOffset;
        sequenceOffset += durationInFrames;

        return (
          <Sequence
            key={scene.id}
            from={from}
            durationInFrames={durationInFrames}
            name={scene.label}
          >
            <VideoScene
              scene={scene}
              config={liveConfig}
              captions={captions}
              onConfigChange={setLiveConfig}
              onCaptionsChange={setCaptions}
            />
          </Sequence>
        );
      })}

      {/* Studio watermark when no steps loaded */}
      {isStudio && liveConfig.steps.length === 0 && (
        <AbsoluteFill
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0d1117",
          }}
        >
          <div
            style={{
              textAlign: "center",
              fontFamily:
                'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
              color: "rgba(255,255,255,0.4)",
            }}
          >
            <div style={{ fontSize: 18, marginBottom: 8 }}>
              No steps in adapter-config.json
            </div>
            <div style={{ fontSize: 13 }}>
              Run{" "}
              <code
                style={{
                  background: "rgba(255,255,255,0.08)",
                  padding: "2px 6px",
                  borderRadius: 4,
                }}
              >
                npm run eval-recorder
              </code>{" "}
              from the project root to set up.
            </div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
