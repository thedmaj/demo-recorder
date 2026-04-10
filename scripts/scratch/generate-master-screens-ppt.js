#!/usr/bin/env node
'use strict';

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { chromium } = require('playwright');
const PptxGenJS = require('pptxgenjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEMOS_DIR = path.join(PROJECT_ROOT, 'out', 'demos');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [k, ...rest] = arg.slice(2).split('=');
    out[k] = rest.length ? rest.join('=') : 'true';
  }
  return out;
}

function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function sanitize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function fitInBox(imgW, imgH, boxX, boxY, boxW, boxH) {
  const imgRatio = imgW / imgH;
  const boxRatio = boxW / boxH;
  let w;
  let h;
  if (imgRatio > boxRatio) {
    w = boxW;
    h = boxW / imgRatio;
  } else {
    h = boxH;
    w = boxH * imgRatio;
  }
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  return { x, y, w, h };
}

function listRunDirs() {
  if (!fs.existsSync(DEMOS_DIR)) return [];
  return fs.readdirSync(DEMOS_DIR)
    .filter((entry) => {
      const runDir = path.join(DEMOS_DIR, entry);
      if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) return false;
      return fs.existsSync(path.join(runDir, 'scratch-app', 'index.html'));
    })
    .sort();
}

function getRunSteps(runDir) {
  const demoScript = loadJson(path.join(runDir, 'demo-script.json'), {});
  const steps = Array.isArray(demoScript.steps) ? demoScript.steps : [];
  return steps.map((s, i) => ({
    id: String(s.id || `step-${i + 1}`),
    label: String(s.label || s.id || `Step ${i + 1}`),
  }));
}

async function startStaticServer(rootDir) {
  const app = express();
  app.use(express.static(rootDir));
  const server = await new Promise((resolve, reject) => {
    const s = http.createServer(app);
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function captureRunScreens(runId, runDir, outDir) {
  const stepDefs = getRunSteps(runDir);
  if (!stepDefs.length) return [];
  fs.mkdirSync(outDir, { recursive: true });

  const staticServer = await startStaticServer(path.join(runDir, 'scratch-app'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(staticServer.url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(300);

  const hasGoToStep = await page.evaluate(() => typeof window.goToStep === 'function');
  const captured = [];
  for (let i = 0; i < stepDefs.length; i++) {
    const step = stepDefs[i];
    if (hasGoToStep) {
      await page.evaluate((id) => { window.goToStep(id); }, step.id);
      await page.waitForTimeout(250);
    }
    const fileName = `${String(i + 1).padStart(2, '0')}-${sanitize(step.id)}-mid.png`;
    const fp = path.join(outDir, fileName);
    await page.screenshot({ path: fp, fullPage: false });
    captured.push({ stepId: step.id, label: step.label, path: fp });
  }

  await browser.close();
  await staticServer.close();
  console.log(`[master-ppt] captured ${captured.length} step screenshots for ${runId}`);
  return captured;
}

function collectExistingScreens(runDir) {
  const steps = getRunSteps(runDir);
  if (!steps.length) return [];
  const candidates = ['build-frames', 'qa-frames'];
  const out = [];
  for (const step of steps) {
    let found = null;
    for (const folder of candidates) {
      const candidatePath = path.join(runDir, folder, `${step.id}-mid.png`);
      if (fs.existsSync(candidatePath)) {
        found = candidatePath;
        break;
      }
    }
    if (found) out.push({ stepId: step.id, label: step.label, path: found });
  }
  return out;
}

function addCoverSlide(pptx, title, subtitle) {
  const slide = pptx.addSlide();
  slide.background = { color: '0D1117' };
  slide.addText(title, {
    x: 0.6, y: 2.1, w: 12.1, h: 0.9, fontSize: 34, bold: true, color: 'FFFFFF',
  });
  slide.addText(subtitle, {
    x: 0.6, y: 3.2, w: 12.1, h: 0.6, fontSize: 16, color: '8B9AB0',
  });
}

function addRunDividerSlide(pptx, runId, count) {
  const slide = pptx.addSlide();
  slide.background = { color: '111827' };
  slide.addText(runId, {
    x: 0.6, y: 2.5, w: 12.1, h: 0.8, fontSize: 26, bold: true, color: 'FFFFFF',
  });
  slide.addText(`${count} screenshots`, {
    x: 0.6, y: 3.35, w: 12.1, h: 0.5, fontSize: 14, color: '9CA3AF',
  });
}

function addScreenshotSlide(pptx, runId, shot, idx, total) {
  const slide = pptx.addSlide();
  slide.background = { color: '000000' };
  slide.addText(`${runId}  •  ${shot.stepId}  •  ${idx}/${total}`, {
    x: 0.3, y: 0.1, w: 12.7, h: 0.3, fontSize: 10, color: 'D1D5DB',
  });
  const box = fitInBox(1440, 900, 0.2, 0.5, 12.9, 6.8);
  slide.addImage({ path: shot.path, x: box.x, y: box.y, w: box.w, h: box.h });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contains = String(args.contains || 'SCREEN').trim();
  const fallbackAll = String(args.fallbackAll || 'true').toLowerCase() === 'true';
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const defaultOutput = path.join(DEMOS_DIR, `master-screens-${sanitize(contains || 'all')}-${stamp}.pptx`);
  const output = path.resolve(args.output || defaultOutput);

  const allRuns = listRunDirs();
  if (!allRuns.length) {
    throw new Error(`No demo app runs found under ${DEMOS_DIR}`);
  }

  let targetRuns = allRuns.filter((r) => r.toLowerCase().includes(contains.toLowerCase()));
  if (!targetRuns.length && fallbackAll) {
    console.warn(`[master-ppt] No runs matched "${contains}". Falling back to all ${allRuns.length} runs.`);
    targetRuns = allRuns;
  }
  if (!targetRuns.length) {
    throw new Error(`No run folders matched "${contains}" and fallbackAll=false.`);
  }

  const byRun = [];
  for (const runId of targetRuns) {
    const runDir = path.join(DEMOS_DIR, runId);
    let shots = collectExistingScreens(runDir);
    if (!shots.length) {
      const captureDir = path.join(runDir, 'build-frames');
      shots = await captureRunScreens(runId, runDir, captureDir);
    }
    if (shots.length) byRun.push({ runId, shots });
  }

  if (!byRun.length) {
    throw new Error('No screenshots found or captured for selected runs.');
  }

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDESCREEN', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDESCREEN';
  pptx.author = 'Plaid Demo Pipeline';
  pptx.company = 'Plaid';
  pptx.title = `Master Screens - ${contains || 'all'}`;

  const totalImages = byRun.reduce((n, r) => n + r.shots.length, 0);
  addCoverSlide(pptx, 'Master Demo Screenshots', `Filter: ${contains || 'all'} • Apps: ${byRun.length} • Images: ${totalImages}`);

  for (const run of byRun) {
    addRunDividerSlide(pptx, run.runId, run.shots.length);
    run.shots.forEach((shot, i) => addScreenshotSlide(pptx, run.runId, shot, i + 1, run.shots.length));
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  await pptx.writeFile({ fileName: output });
  console.log(`[master-ppt] wrote ${output}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[master-ppt] failed:', err.message);
    process.exit(1);
  });
}

