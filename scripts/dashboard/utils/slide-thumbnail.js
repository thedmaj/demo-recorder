'use strict';
/**
 * slide-thumbnail.js
 *
 * Renders the build-preview / qa-frame thumbnail PNGs for a slide-kind step
 * inserted into a storyboard. Supports two modes:
 *
 *   - LIBRARY MODE: a slide imported from out/slide-library/ has a real
 *     HTML file we can render directly. Used by /api/runs/:runId/insert-library-slide.
 *
 *   - PLACEHOLDER MODE: a custom slide inserted via /api/runs/:runId/insert-step
 *     has no HTML yet — the post-slides stage will render the real content
 *     on the next pipeline run. Until then we render a Plaid-styled placeholder
 *     so the storyboard card shows something meaningful instead of "No frame".
 *
 * Both modes write identical PNGs to <run>/build-frames/<stepId>-mid.png AND
 * <run>/qa-frames/<stepId>-mid.png so the dashboard's storyboard view picks
 * them up regardless of which list it consults.
 *
 * The Playwright dependency is unavoidable (Brandfetch + browser-extracted
 * brand tokens are how we get accurate colors), but the helper is small and
 * cheap (~1s wall-clock per call, since the page never loads remote assets).
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SLIDE_LIBRARY_DIR = path.join(PROJECT_ROOT, 'out', 'slide-library');

// Plaid brand-y placeholder for custom slides. Mirrors the dark slide
// aesthetic from templates/slide-template/pipeline-slide-shell.html (navy
// background, teal accent, mono endpoint pill in the header) so a custom
// slide preview is visually consistent with what the post-slides stage
// will eventually render.
function buildPlaceholderHtml({ label, narration, sceneType }) {
  const safeLabel = String(label || 'Custom slide')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeNarrationFull = String(narration || 'Pending build — the post-slides stage will render this slide on the next pipeline run.')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Truncate narration to ~280 chars so it fits visually:
  const safeNarration = safeNarrationFull.length > 280
    ? safeNarrationFull.slice(0, 280).trim() + '…'
    : safeNarrationFull;
  const sceneTypeLabel = String(sceneType || 'slide').toUpperCase();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: dark; }
    body { margin:0; background:#0d1117; font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif; color:#fff; }
    .slide-root {
      width:100vw; min-height:100vh; box-sizing:border-box;
      padding:48px 64px; display:flex; flex-direction:column; gap:32px;
      background:linear-gradient(135deg,#0d1117 0%,#0f1d2e 50%,#0a1a2e 100%);
    }
    .slide-header {
      display:flex; align-items:center; gap:16px; padding-bottom:24px;
      border-bottom:1px solid rgba(255,255,255,0.08);
    }
    .slide-header-pill {
      background:rgba(0,166,126,0.12); color:#00A67E; border:1px solid rgba(0,166,126,0.28);
      font-weight:700; font-size:12px; letter-spacing:.16em;
      padding:6px 12px; border-radius:6px;
    }
    .slide-header-meta {
      font:500 11px/1.4 'SF Mono','Fira Code',Consolas,monospace;
      letter-spacing:.08em; color:rgba(255,255,255,0.45); text-transform:uppercase;
    }
    .slide-pending-badge {
      margin-left:auto; padding:5px 10px; border-radius:4px;
      background:rgba(255,191,0,0.12); color:#FFC857; border:1px solid rgba(255,191,0,0.32);
      font:600 11px/1 'Inter',sans-serif; letter-spacing:.08em; text-transform:uppercase;
    }
    .slide-body {
      flex:1; display:flex; flex-direction:column; justify-content:center;
      gap:28px; max-width:980px;
    }
    .slide-title {
      font-size:64px; line-height:1.08; font-weight:700; margin:0;
      letter-spacing:-0.015em;
    }
    .slide-subtitle {
      font-size:22px; line-height:1.4; margin:0; max-width:780px;
      color:rgba(255,255,255,0.72); font-weight:400;
    }
    .slide-callout {
      margin-top:24px; padding:18px 24px; border-radius:10px;
      background:rgba(0,166,126,0.08); border-left:4px solid #00A67E;
      font-size:14px; line-height:1.5; color:rgba(255,255,255,0.85);
      max-width:780px;
    }
    .slide-footer {
      display:flex; align-items:center; gap:8px;
      font:500 11px/1 'SF Mono','Fira Code',Consolas,monospace;
      letter-spacing:.08em; color:rgba(255,255,255,0.32);
      text-transform:uppercase; padding-top:16px;
      border-top:1px solid rgba(255,255,255,0.06);
    }
  </style>
</head>
<body>
  <div class="slide-root">
    <header class="slide-header">
      <div class="slide-header-pill">PLAID</div>
      <div class="slide-header-meta">${sceneTypeLabel} · placeholder preview</div>
      <div class="slide-pending-badge">⏳ Pending build</div>
    </header>
    <main class="slide-body">
      <h1 class="slide-title">${safeLabel}</h1>
      <p class="slide-subtitle">${safeNarration}</p>
      <div class="slide-callout">
        This is a placeholder rendered when the slide was inserted from the storyboard.
        The next pipeline run's <strong>post-slides</strong> stage will replace this with
        a Plaid-styled slide using your brand's design system, real product copy, and
        synced narration timing.
      </div>
    </main>
    <footer class="slide-footer">
      <span>plaid demo recorder · custom slide preview</span>
    </footer>
  </div>
</body>
</html>`;
}

// Resolve the targets we'll write the PNG to. Both build-frames and qa-frames
// because the storyboard renders from whichever is populated first.
function resolveTargets(runDir, stepId) {
  return [
    path.join(runDir, 'build-frames', `${stepId}-mid.png`),
    path.join(runDir, 'qa-frames', `${stepId}-mid.png`),
  ];
}

async function renderHtmlToPng(html) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Brief settle so web fonts (system-ui in placeholder) render fully:
    await page.waitForTimeout(140);
    return await page.screenshot({ fullPage: false, type: 'png' });
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Generate a thumbnail for a library slide.
 *
 * Reads the slide's HTML (path-traversal-guarded against the slide library
 * dir) and renders it via Playwright. Writes to both build-frames and
 * qa-frames. Returns `{ written: string[], mode: 'library' }` (written paths
 * are absolute filesystem paths). Returns `{ written: [], skipped: true,
 * reason }` when prerequisites aren't met (no slide.htmlPath, file missing,
 * outside library dir).
 *
 * Drop-in replacement for the inline generateLibraryStepThumbnailsForRun in
 * server.js with the same return shape (`written`).
 */
async function generateLibrarySlideThumbnail(runDir, stepId, slide) {
  if (!runDir || !stepId || !slide || !slide.htmlPath) {
    return { written: [], skipped: true, reason: 'missing-args', mode: 'library' };
  }
  const htmlAbs = path.resolve(PROJECT_ROOT, slide.htmlPath);
  if (!htmlAbs.startsWith(SLIDE_LIBRARY_DIR + path.sep)) {
    return { written: [], skipped: true, reason: 'outside-library-dir', mode: 'library' };
  }
  if (!fs.existsSync(htmlAbs)) {
    return { written: [], skipped: true, reason: 'slide-html-missing', mode: 'library' };
  }
  const html = fs.readFileSync(htmlAbs, 'utf8');
  const png = await renderHtmlToPng(html);
  const targets = resolveTargets(runDir, stepId);
  for (const outPath of targets) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
  }
  return { written: targets, skipped: false, reason: null, mode: 'library' };
}

/**
 * Generate a placeholder thumbnail for a custom slide step.
 *
 * Used by /api/runs/:runId/insert-step when the user adds a slide-kind step
 * that has no library HTML. Renders a Plaid-styled "pending build" preview
 * so the storyboard card shows something meaningful (not "No frame") until
 * the next pipeline run's post-slides stage renders the real content.
 *
 * Returns the same `{ written, skipped, reason, mode }` shape as the
 * library variant for caller consistency.
 */
async function generatePlaceholderSlideThumbnail(runDir, stepId, step) {
  if (!runDir || !stepId) {
    return { written: [], skipped: true, reason: 'missing-args', mode: 'placeholder' };
  }
  const html = buildPlaceholderHtml({
    label: step && step.label,
    narration: step && step.narration,
    sceneType: step && step.sceneType,
  });
  const png = await renderHtmlToPng(html);
  const targets = resolveTargets(runDir, stepId);
  for (const outPath of targets) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
  }
  return { written: targets, skipped: false, reason: null, mode: 'placeholder' };
}

/**
 * Top-level dispatcher used by both insert endpoints. Picks the right
 * generator based on what's available on the step:
 *   - step.slideLibraryRef  → library mode (renders the imported slide HTML)
 *   - otherwise              → placeholder mode
 *
 * Caller passes the resolved library `slide` object when known (insert-library-slide
 * has it from readSlideLibraryIndex; insert-step doesn't). When `slide` is null
 * but `step.slideLibraryRef` is set, falls through to placeholder mode rather
 * than failing.
 */
async function generateSlideStepThumbnail(runDir, stepId, step, slide) {
  if (slide && slide.htmlPath) {
    const out = await generateLibrarySlideThumbnail(runDir, stepId, slide);
    if (out.written.length > 0) return out;
    // Library mode failed (slide HTML moved/deleted) — fall through to placeholder
    // so the user still gets a card thumbnail.
  }
  return await generatePlaceholderSlideThumbnail(runDir, stepId, step);
}

module.exports = {
  generateSlideStepThumbnail,
  generateLibrarySlideThumbnail,
  generatePlaceholderSlideThumbnail,
  // Exposed for tests:
  buildPlaceholderHtml,
  resolveTargets,
};
