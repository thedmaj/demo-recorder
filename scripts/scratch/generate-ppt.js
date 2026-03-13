#!/usr/bin/env node
/**
 * generate-ppt.js
 * Generates a PowerPoint summary of the demo after each render.
 * Uses pptxgenjs (no API costs).
 *
 * Reads:  out/demo-script.json
 *         out/qa-frames/ (step screenshots extracted during QA review)
 * Writes: out/demos/{version}/demo-summary.pptx
 *         Also copies to out/demo-summary.pptx (convenience symlink)
 *
 * Usage: node scripts/scratch/generate-ppt.js
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const PptxGenJS = require('pptxgenjs');
const Anthropic = require('@anthropic-ai/sdk');

// ── Paths ──────────────────────────────────────────────────────────────────────
const PROJECT_ROOT       = path.resolve(__dirname, '../..');
const OUT_DIR            = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const DEMO_SCRIPT_PATH   = path.join(OUT_DIR, 'demo-script.json');
const STEP_TIMING_PATH   = path.join(OUT_DIR, 'step-timing.json');
const QA_FRAMES_DIR      = path.join(OUT_DIR, 'qa-frames');
const FRAMES_DIR         = path.join(OUT_DIR, 'frames');
const PRODUCT_RESEARCH   = path.join(OUT_DIR, 'product-research.json');
const OUTPUT_PPT         = path.join(OUT_DIR, 'demo-summary.pptx');

// ── Design tokens (Plaid brand) ────────────────────────────────────────────────
const BG_COLOR     = '0d1117';
const TEXT_WHITE   = 'FFFFFF';
const ACCENT_TEAL  = '00A67E';
const TEXT_DIM     = '8B9AB0';

// ── Helper: pad a number to 4 digits ──────────────────────────────────────────
function padFrame(n) {
  return String(n).padStart(4, '0');
}

// ── Helper: read image pixel dimensions without external packages ──────────────
// Supports PNG and JPEG. Returns { width, height } or null on failure.
function readImageDimensions(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(24);
    fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);

    // PNG: signature 8 bytes, then IHDR chunk: 4-length 4-"IHDR" 4-width 4-height
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (header.slice(0, 8).equals(PNG_SIG)) {
      return {
        width:  header.readUInt32BE(16),
        height: header.readUInt32BE(20),
      };
    }

    // JPEG: scan for SOFn markers (FF C0, FF C2) — need more bytes
    if (header[0] === 0xff && header[1] === 0xd8) {
      const fd2 = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(Math.min(fs.statSync(filePath).size, 65536));
      fs.readSync(fd2, buf, 0, buf.length, 0);
      fs.closeSync(fd2);
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        // SOF markers: C0, C1, C2, C3, C5, C6, C7, C9, CA, CB, CD, CE, CF
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {
            height: buf.readUInt16BE(i + 5),
            width:  buf.readUInt16BE(i + 7),
          };
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
  } catch (_) {}
  return null;
}

// ── Helper: fit dimensions into a container preserving aspect ratio ────────────
// Returns { w, h, x, y } with the image centred inside the container box.
function fitInBox(imgW, imgH, boxX, boxY, boxW, boxH) {
  const imgRatio = imgW / imgH;
  const boxRatio = boxW / boxH;

  let dispW, dispH;
  if (imgRatio > boxRatio) {
    // Image is wider relative to box — constrain by width
    dispW = boxW;
    dispH = boxW / imgRatio;
  } else {
    // Image is taller relative to box — constrain by height
    dispH = boxH;
    dispW = boxH * imgRatio;
  }

  // Centre within box
  const x = boxX + (boxW - dispW) / 2;
  const y = boxY + (boxH - dispH) / 2;

  return { w: dispW, h: dispH, x, y };
}

// ── Helper: find screenshot for a step ────────────────────────────────────────
function findScreenshot(stepId, midFrame) {
  // Try qa-frames first: e.g. out/qa-frames/01-welcome-mid.png
  const qaPath = path.join(QA_FRAMES_DIR, `${stepId}-mid.png`);
  if (fs.existsSync(qaPath)) return qaPath;

  // Fallback: rendered frame jpg from out/frames/
  if (midFrame != null) {
    const framePath = path.join(FRAMES_DIR, `frame_${padFrame(midFrame)}.jpg`);
    if (fs.existsSync(framePath)) return framePath;
  }

  return null;
}

// ── Helper: load JSON safely ───────────────────────────────────────────────────
function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── Batch bullet-point generation via Claude Haiku ────────────────────────────
async function generateBullets(steps) {
  const client = new Anthropic();

  // Build a single prompt with all narrations numbered
  const narrationList = steps
    .map((s, i) => `[${i + 1}] Step "${s.label}": ${s.narration || s.label}`)
    .join('\n');

  const prompt = `You are writing PowerPoint slide bullets for a Plaid product demo.

For each numbered step below, produce exactly 3–5 concise bullet points that capture the key talking points. Each bullet should be under 12 words. Use active voice and outcome-focused language. No markdown headers, no extra commentary — just the bullets.

Format your response as:
[1]
• bullet one
• bullet two
• bullet three

[2]
• bullet one
...

Steps:
${narrationList}`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0]?.text || '';

  // Parse response — split by [N] markers
  const result = [];
  const blocks = text.split(/\[(\d+)\]/);
  // blocks: ['', '1', '\n• ...\n', '2', '\n• ...\n', ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const idx = parseInt(blocks[i], 10) - 1;
    const raw = blocks[i + 1] || '';
    const bullets = raw
      .split('\n')
      .map(l => l.replace(/^[•\-*]\s*/, '').trim())
      .filter(l => l.length > 0);
    result[idx] = bullets;
  }

  // Fill any gaps with a fallback
  return steps.map((s, i) => result[i] || [s.label]);
}

// ── Slide builders ─────────────────────────────────────────────────────────────

function addCoverSlide(pptx, script, today) {
  const slide = pptx.addSlide();
  slide.background = { color: BG_COLOR };

  // Plaid teal accent bar at top
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 13.33, h: 0.08,
    fill: { color: ACCENT_TEAL },
    line: { color: ACCENT_TEAL },
  });

  // "PLAID" wordmark
  slide.addText('PLAID', {
    x: 0.6, y: 0.5, w: 12, h: 0.4,
    fontSize: 14,
    bold: true,
    color: ACCENT_TEAL,
    charSpacing: 6,
    fontFace: 'Arial',
  });

  // Product / demo title
  const productName = script.productName || script.product || 'Plaid Demo';
  slide.addText(productName, {
    x: 0.6, y: 1.1, w: 12, h: 1.4,
    fontSize: 44,
    bold: true,
    color: TEXT_WHITE,
    fontFace: 'Arial',
    wrap: true,
  });

  // Persona + company
  const persona = script.persona || {};
  const personaLine = [persona.name, persona.company].filter(Boolean).join(' · ');
  if (personaLine) {
    slide.addText(personaLine, {
      x: 0.6, y: 2.65, w: 12, h: 0.45,
      fontSize: 18,
      color: TEXT_DIM,
      fontFace: 'Arial',
    });
  }

  // Use case
  const useCase = script.useCase || persona.useCase || '';
  if (useCase) {
    slide.addText(useCase, {
      x: 0.6, y: 3.2, w: 10, h: 0.5,
      fontSize: 16,
      color: TEXT_DIM,
      fontFace: 'Arial',
      italic: true,
    });
  }

  // Teal divider line
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.6, y: 3.85, w: 3.5, h: 0.05,
    fill: { color: ACCENT_TEAL },
    line: { color: ACCENT_TEAL },
  });

  // Demo date
  slide.addText(`Demo · ${today}`, {
    x: 0.6, y: 4.05, w: 5, h: 0.4,
    fontSize: 13,
    color: TEXT_DIM,
    fontFace: 'Arial',
  });
}

function addStepSlide(pptx, step, bullets, screenshotPath) {
  const slide = pptx.addSlide();
  slide.background = { color: BG_COLOR };

  const hasImage = screenshotPath != null;

  // Teal accent bar on left edge
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.07, h: 7.5,
    fill: { color: ACCENT_TEAL },
    line: { color: ACCENT_TEAL },
  });

  if (hasImage) {
    // Left half: screenshot — compute exact display size to preserve aspect ratio
    try {
      // Available image area on left half of slide
      const BOX_X = 0.25, BOX_Y = 0.3, BOX_W = 6.0, BOX_H = 6.7;

      const dims = readImageDimensions(screenshotPath);
      let imgProps;
      if (dims && dims.width > 0 && dims.height > 0) {
        imgProps = fitInBox(dims.width, dims.height, BOX_X, BOX_Y, BOX_W, BOX_H);
      } else {
        // Fallback: assume 16:10 (1440×900 QA frame) if dimensions unavailable
        imgProps = fitInBox(1440, 900, BOX_X, BOX_Y, BOX_W, BOX_H);
      }

      slide.addImage({
        path: screenshotPath,
        x: imgProps.x,
        y: imgProps.y,
        w: imgProps.w,
        h: imgProps.h,
      });
    } catch {
      // If image fails to load, fall through to text-only layout
    }

    // Right half: label + bullets
    slide.addText(step.label || step.id, {
      x: 6.6, y: 0.55, w: 6.4, h: 0.7,
      fontSize: 22,
      bold: true,
      color: TEXT_WHITE,
      fontFace: 'Arial',
      wrap: true,
    });

    const bulletText = bullets.map(b => ({ text: b, options: { bullet: true } }));
    slide.addText(bulletText, {
      x: 6.6, y: 1.45, w: 6.4, h: 5.7,
      fontSize: 16,
      color: TEXT_WHITE,
      fontFace: 'Arial',
      lineSpacingMultiple: 1.3,
      valign: 'top',
    });
  } else {
    // Full-width text layout
    slide.addText(step.label || step.id, {
      x: 0.5, y: 0.6, w: 12.5, h: 0.8,
      fontSize: 28,
      bold: true,
      color: TEXT_WHITE,
      fontFace: 'Arial',
      wrap: true,
    });

    const bulletText = bullets.map(b => ({ text: b, options: { bullet: true } }));
    slide.addText(bulletText, {
      x: 0.5, y: 1.7, w: 12.5, h: 5.5,
      fontSize: 18,
      color: TEXT_WHITE,
      fontFace: 'Arial',
      lineSpacingMultiple: 1.4,
      valign: 'top',
    });
  }

  // Step ID label in bottom-right corner
  slide.addText(step.id || '', {
    x: 10, y: 7.05, w: 3.1, h: 0.3,
    fontSize: 10,
    color: TEXT_DIM,
    fontFace: 'Arial',
    align: 'right',
  });
}

function addClosingSlide(pptx, research) {
  const slide = pptx.addSlide();
  slide.background = { color: BG_COLOR };

  // Teal accent bar at top
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 13.33, h: 0.08,
    fill: { color: ACCENT_TEAL },
    line: { color: ACCENT_TEAL },
  });

  slide.addText('Key Value Propositions', {
    x: 0.6, y: 0.4, w: 12, h: 0.6,
    fontSize: 14,
    bold: true,
    color: ACCENT_TEAL,
    charSpacing: 3,
    fontFace: 'Arial',
  });

  const vps = research?.valuePropositions || research?.keyBenefits || [];

  if (vps.length > 0) {
    const vpText = vps.slice(0, 6).map(vp => ({
      text: typeof vp === 'string' ? vp : (vp.text || vp.title || String(vp)),
      options: { bullet: true },
    }));
    slide.addText(vpText, {
      x: 0.6, y: 1.2, w: 12, h: 4.8,
      fontSize: 18,
      color: TEXT_WHITE,
      fontFace: 'Arial',
      lineSpacingMultiple: 1.5,
      valign: 'top',
    });
  }

  // CTA divider
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.6, y: 6.4, w: 12.1, h: 0.04,
    fill: { color: '1e2a36' },
    line: { color: '1e2a36' },
  });

  slide.addText('Ready to learn more? Visit plaid.com/products', {
    x: 0.6, y: 6.6, w: 12, h: 0.5,
    fontSize: 15,
    color: ACCENT_TEAL,
    fontFace: 'Arial',
    bold: true,
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().split('T')[0];

  // Load demo-script.json
  const script = loadJson(DEMO_SCRIPT_PATH);
  if (!script) {
    console.error('ERROR: out/demo-script.json not found. Run the script/voiceover stages first.');
    process.exit(1);
  }

  // Load step-timing.json for step list + frame numbers
  const timing = loadJson(STEP_TIMING_PATH, {});
  const timingSteps = timing.steps || [];
  const fps = timing.fps || 30;

  // Merge script steps with timing steps to get label + narration + frame info
  const scriptSteps = script.steps || [];
  const steps = scriptSteps.map(ss => {
    const ts = timingSteps.find(t => t.id === ss.id) || {};
    const startFrame = ts.startFrame ?? 0;
    const endFrame   = ts.endFrame ?? startFrame + 300;
    const midFrame   = Math.round((startFrame + endFrame) / 2);
    return {
      id:        ss.id,
      label:     ss.label || ss.title || ss.id,
      narration: ss.narration || ss.voiceover || '',
      midFrame,
    };
  });

  if (steps.length === 0) {
    console.error('ERROR: No steps found in demo-script.json.');
    process.exit(1);
  }

  // Resolve screenshots for each step
  const screenshots = steps.map(s => findScreenshot(s.id, s.midFrame));

  // Generate bullets via Claude Haiku (single batched call)
  console.log(`Generating bullet points for ${steps.length} steps via Claude Haiku...`);
  let allBullets;
  try {
    allBullets = await generateBullets(steps);
  } catch (err) {
    console.warn('WARNING: Claude Haiku call failed, using narration text as fallback.', err.message);
    allBullets = steps.map(s => [s.narration || s.label]);
  }

  // Load product research (optional)
  const research = loadJson(PRODUCT_RESEARCH, null);

  // Build the PowerPoint
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDESCREEN', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDESCREEN';
  pptx.author  = 'Plaid Demo Pipeline';
  pptx.company = 'Plaid';
  pptx.title   = script.productName || 'Plaid Demo';

  // Slide 1: Cover
  addCoverSlide(pptx, script, today);

  // Slides 2–N: One per step
  steps.forEach((step, i) => {
    const bullets     = allBullets[i] || [step.label];
    const screenshot  = screenshots[i];
    if (screenshot) {
      console.log(`  Step ${i + 1}/${steps.length}: ${step.id} — screenshot: ${path.basename(screenshot)}`);
    } else {
      console.log(`  Step ${i + 1}/${steps.length}: ${step.id} — no screenshot (text-only slide)`);
    }
    addStepSlide(pptx, step, bullets, screenshot);
  });

  // Final slide: value props + CTA
  addClosingSlide(pptx, research);

  // Determine output path
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Write primary output
  await pptx.writeFile({ fileName: OUTPUT_PPT });
  console.log(`\nPowerPoint written to: ${OUTPUT_PPT}`);

  // Also write to versioned dir if out/latest/ symlink exists
  try {
    const latestLink = path.join(OUT_DIR, 'latest');
    const latestStat = fs.lstatSync(latestLink);
    if (latestStat.isSymbolicLink()) {
      const latestDir = fs.realpathSync(latestLink);
      const versionedPath = path.join(latestDir, 'demo-summary.pptx');
      await pptx.writeFile({ fileName: versionedPath });
      console.log(`Also written to versioned dir: ${versionedPath}`);
    }
  } catch {
    // out/latest/ doesn't exist — skip
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('generate-ppt.js failed:', err);
    process.exit(1);
  });
}
