import React, { useState } from "react";
import type { Word } from "./types";

interface EditCaptionProps {
  word: Word;
  onSave: (updated: Word) => void;
  onDelete: () => void;
  onClose: () => void;
}

export const EditCaption: React.FC<EditCaptionProps> = ({
  word,
  onSave,
  onDelete,
  onClose,
}) => {
  const [text, setText] = useState(word.word);
  const [start, setStart] = useState(String(word.start.toFixed(3)));
  const [end, setEnd] = useState(String(word.end.toFixed(3)));

  const handleSave = () => {
    const s = parseFloat(start);
    const e = parseFloat(end);
    if (isNaN(s) || isNaN(e) || e <= s) {
      alert("Invalid timing: end must be greater than start.");
      return;
    }
    onSave({ ...word, word: text, start: s, end: e });
  };

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  };

  const panel: React.CSSProperties = {
    background: "#161b22",
    border: "1px solid rgba(0,166,126,0.45)",
    borderRadius: 10,
    padding: "24px 28px",
    width: 340,
    fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    color: "#fff",
  };

  const label: React.CSSProperties = {
    fontSize: 12,
    color: "rgba(255,255,255,0.55)",
    marginBottom: 6,
    display: "block",
  };

  const input: React.CSSProperties = {
    width: "100%",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    padding: "8px 10px",
    color: "#fff",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
    marginBottom: 14,
  };

  const rowStyle: React.CSSProperties = {
    display: "flex",
    gap: 10,
  };

  const halfInput: React.CSSProperties = {
    ...input,
    flex: 1,
  };

  const btnRow: React.CSSProperties = {
    display: "flex",
    gap: 8,
    marginTop: 6,
  };

  const btnPrimary: React.CSSProperties = {
    flex: 1,
    padding: "9px 0",
    background: "#00A67E",
    color: "#000",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  };

  const btnSecondary: React.CSSProperties = {
    padding: "9px 14px",
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    fontSize: 13,
    cursor: "pointer",
  };

  const btnDanger: React.CSSProperties = {
    ...btnSecondary,
    color: "#f87171",
    borderColor: "rgba(248,113,113,0.3)",
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ marginBottom: 18, fontSize: 15, fontWeight: 600 }}>
          Edit Caption Word
        </div>

        <label style={label}>Word text</label>
        <input
          style={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />

        <label style={label}>Timing (seconds)</label>
        <div style={rowStyle}>
          <input
            style={halfInput}
            placeholder="Start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <input
            style={halfInput}
            placeholder="End"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>

        <div style={btnRow}>
          <button style={btnPrimary} onClick={handleSave}>
            Save
          </button>
          <button style={btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button style={btnDanger} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};
