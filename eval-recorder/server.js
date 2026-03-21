/**
 * eval-recorder/server.js
 *
 * Lightweight Express server that handles file RPC for Remotion Studio's
 * writeStaticFile / readStaticFile APIs, and launches Remotion Studio on
 * port 4001 as a child process.
 *
 * Port 4041 — file API server
 * Port 4001 — Remotion Studio (spawned below)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = 4041;
const PUBLIC = path.join(__dirname, "public");
const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.static(PUBLIC));

// ── File RPC endpoints (mirror Remotion Studio's built-in file API) ──────────

/** Write a file into public/ */
app.post("/api/writeStaticFile", (req, res) => {
  const { filePath, contents } = req.body;
  if (!filePath || typeof contents !== "string") {
    return res.status(400).json({ error: "filePath and contents are required" });
  }
  const abs = path.join(PUBLIC, filePath);
  // Prevent path traversal outside public/
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== PUBLIC) {
    return res.status(403).json({ error: "Path outside public/ is not allowed" });
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  console.log(`[eval-recorder] writeStaticFile: ${filePath}`);
  res.json({ success: true });
});

/** Read a file from public/ */
app.post("/api/readStaticFile", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: "filePath is required" });
  }
  const abs = path.join(PUBLIC, filePath);
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== PUBLIC) {
    return res.status(403).json({ error: "Path outside public/ is not allowed" });
  }
  if (!fs.existsSync(abs)) {
    return res.json({ contents: null });
  }
  res.json({ contents: fs.readFileSync(abs, "utf8") });
});

/** Delete a file from public/ */
app.post("/api/deleteStaticFile", (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: "filePath is required" });
  }
  const abs = path.join(PUBLIC, filePath);
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== PUBLIC) {
    return res.status(403).json({ error: "Path outside public/ is not allowed" });
  }
  if (fs.existsSync(abs)) {
    fs.unlinkSync(abs);
    console.log(`[eval-recorder] deleteStaticFile: ${filePath}`);
  }
  res.json({ success: true });
});

/** List files in public/ */
app.get("/api/listStaticFiles", (_req, res) => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(PUBLIC, full).replace(/\\/g, "/"));
      }
    }
  };
  if (fs.existsSync(PUBLIC)) walk(PUBLIC);
  res.json({ files });
});

// ── Start server ─────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`\n[eval-recorder] File API server → http://localhost:${PORT}`);
  console.log(`[eval-recorder] Remotion Studio  → http://localhost:4001\n`);
});

// ── Launch Remotion Studio on port 4001 ──────────────────────────────────────

const studioArgs = [
  "remotion",
  "studio",
  "remotion/index.ts",
  "--port=4001",
];

// Pass --props if adapter-config.json exists
const adapterConfig = path.join(__dirname, "adapter-config.json");
if (fs.existsSync(adapterConfig)) {
  studioArgs.push("--props=adapter-config.json");
}

const studio = spawn("npx", studioArgs, {
  cwd: __dirname,
  stdio: "inherit",
  shell: process.platform === "win32",
});

studio.on("error", (err) => {
  console.error("[eval-recorder] Failed to launch Remotion Studio:", err.message);
});

studio.on("close", (code) => {
  console.log(`[eval-recorder] Remotion Studio exited (code ${code})`);
  server.close();
  process.exit(code || 0);
});

process.on("SIGINT", () => {
  studio.kill("SIGINT");
  server.close();
});

process.on("SIGTERM", () => {
  studio.kill("SIGTERM");
  server.close();
});
