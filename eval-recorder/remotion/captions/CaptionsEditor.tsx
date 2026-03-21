import React, { useState, useCallback } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Captions, Word } from "./types";
import { EditCaption } from "./EditCaption";

interface CaptionsEditorProps {
  captions: Captions;
  captionsFile: string;
  /** Start time offset (seconds) for this scene within the full captions */
  sceneStartS: number;
  onCaptionsChange: (updated: Captions) => void;
}

export const CaptionsEditor: React.FC<CaptionsEditorProps> = ({
  captions,
  captionsFile,
  sceneStartS,
  onCaptionsChange,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const currentTimeS = sceneStartS + frame / fps;
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const persistCaptions = useCallback(
    async (updated: Captions) => {
      setSaving(true);
      try {
        // writeStaticFile is only available in Remotion Studio
        const { writeStaticFile } = await import("@remotion/studio");
        await writeStaticFile({
          filePath: captionsFile,
          contents: JSON.stringify(updated, null, 2),
        });
        onCaptionsChange(updated);
      } catch (err) {
        console.error("Failed to save captions:", err);
      } finally {
        setSaving(false);
      }
    },
    [captionsFile, onCaptionsChange]
  );

  const handleWordUpdate = useCallback(
    (index: number, updated: Word) => {
      const newCaptions: Captions = {
        ...captions,
        words: captions.words.map((w, i) => (i === index ? updated : w)),
      };
      persistCaptions(newCaptions);
      setEditingIndex(null);
    },
    [captions, persistCaptions]
  );

  const handleWordDelete = useCallback(
    (index: number) => {
      const newCaptions: Captions = {
        ...captions,
        words: captions.words.filter((_, i) => i !== index),
      };
      persistCaptions(newCaptions);
      setEditingIndex(null);
    },
    [captions, persistCaptions]
  );

  // Only show words that belong to this scene's time range
  const sceneEndS = sceneStartS + durationInFrames / fps;
  const sceneWords = captions.words.filter(
    (w) => w.end > sceneStartS && w.start < sceneEndS
  );

  const containerStyle: React.CSSProperties = {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    background: "rgba(0,0,0,0.88)",
    backdropFilter: "blur(8px)",
    padding: "10px 14px",
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    maxHeight: 150,
    overflowY: "auto",
    zIndex: 50,
    borderTop: "1px solid rgba(0,166,126,0.3)",
  };

  const titleStyle: React.CSSProperties = {
    width: "100%",
    fontSize: 10,
    color: "rgba(255,255,255,0.35)",
    marginBottom: 4,
    fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  };

  return (
    <div style={containerStyle}>
      <div style={titleStyle}>
        Caption Editor {saving ? "— saving…" : "— click word to edit"}
      </div>
      {sceneWords.map((word, idx) => {
        // Find absolute index in captions.words
        const absIdx = captions.words.indexOf(word);
        const isActive =
          currentTimeS >= word.start && currentTimeS < word.end;
        return (
          <span
            key={absIdx}
            onClick={() => setEditingIndex(absIdx)}
            style={{
              background: isActive
                ? "#00A67E"
                : "rgba(255,255,255,0.08)",
              color: isActive ? "#000" : "rgba(255,255,255,0.8)",
              padding: "3px 7px",
              borderRadius: 4,
              fontSize: 12,
              cursor: "pointer",
              border: `1px solid ${isActive ? "#00A67E" : "rgba(255,255,255,0.12)"}`,
              fontWeight: isActive ? 700 : 400,
              transition: "background 0.1s",
              fontFamily:
                'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
            }}
          >
            {word.word}
          </span>
        );
      })}
      {sceneWords.length === 0 && (
        <span
          style={{
            fontSize: 12,
            color: "rgba(255,255,255,0.3)",
            fontFamily:
              'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
          }}
        >
          No captions for this scene
        </span>
      )}
      {editingIndex !== null && (
        <EditCaption
          word={captions.words[editingIndex]}
          onSave={(updated) => handleWordUpdate(editingIndex, updated)}
          onDelete={() => handleWordDelete(editingIndex)}
          onClose={() => setEditingIndex(null)}
        />
      )}
    </div>
  );
};
