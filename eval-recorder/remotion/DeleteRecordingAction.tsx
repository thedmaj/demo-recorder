import React, { useState, useCallback } from "react";
import type { AdapterConfig, SceneConfig } from "./captions/types";

interface DeleteRecordingActionProps {
  scene: SceneConfig;
  config: AdapterConfig;
  onConfigChange: (updated: AdapterConfig) => void;
}

export const DeleteRecordingAction: React.FC<DeleteRecordingActionProps> = ({
  scene,
  config,
  onConfigChange,
}) => {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const updated: AdapterConfig = {
        ...config,
        steps: config.steps.filter((s) => s.id !== scene.id),
      };

      const { writeStaticFile, saveDefaultProps } = await import(
        "@remotion/studio"
      );

      // Persist the updated config
      await writeStaticFile({
        filePath: "adapter-config.json",
        contents: JSON.stringify(updated, null, 2),
      });

      // Update the composition default props so Studio reloads
      await saveDefaultProps({
        compositionId: "EvalDemo",
        defaultProps: updated,
      });

      onConfigChange(updated);
    } catch (err) {
      console.error("Failed to delete scene:", err);
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  }, [scene, config, onConfigChange]);

  const btnBase: React.CSSProperties = {
    padding: "5px 10px",
    borderRadius: 5,
    fontSize: 11,
    cursor: "pointer",
    fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    fontWeight: 500,
    border: "none",
  };

  if (deleting) {
    return (
      <span
        style={{
          ...btnBase,
          background: "transparent",
          color: "rgba(255,255,255,0.35)",
        }}
      >
        Deleting…
      </span>
    );
  }

  if (confirming) {
    return (
      <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <span
          style={{
            fontSize: 11,
            color: "#f87171",
            fontFamily:
              'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
          }}
        >
          Delete "{scene.label}"?
        </span>
        <button
          style={{ ...btnBase, background: "#f87171", color: "#000" }}
          onClick={handleDelete}
        >
          Confirm
        </button>
        <button
          style={{
            ...btnBase,
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
          }}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      style={{
        ...btnBase,
        background: "rgba(248,113,113,0.12)",
        color: "#f87171",
        border: "1px solid rgba(248,113,113,0.25)",
      }}
      onClick={() => setConfirming(true)}
      title={`Delete scene: ${scene.label}`}
    >
      ✕ Delete scene
    </button>
  );
};
