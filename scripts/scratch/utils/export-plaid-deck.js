'use strict';

/**
 * Standalone Plaid HTML deck exporter.
 *
 * Reads a manifest JSON describing slides (id, template, narration, sourceHtml)
 * and assembles a single self-contained HTML file using the Plaid Deck Design
 * System tokens — same colors_and_type.css / slide.css / pipeline-slide-contract.css
 * that the pipeline injects. Fonts and logos are copied next to the output so
 * the file is portable to any browser.
 *
 * Usage:
 *   node scripts/scratch/utils/export-plaid-deck.js \
 *     --manifest path/to/deck.manifest.json \
 *     --out path/to/deck.html \
 *     [--canvas pipeline|authoring] \
 *     [--nav keyboard]
 *
 * Defaults: --canvas pipeline (1280x800), no keyboard nav (static only).
 *
 * The exporter validates that no Workhorse-leak patterns slipped into the
 * source HTML (themes / runtime / Chart.js / motion attrs) and logs warnings
 * before writing; it does NOT block, since standalone exports are looser than
 * pipeline recordings.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SLIDE_TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates', 'slide-template');

const CANVAS_PROFILES = {
  pipeline: { width: 1280, height: 800, label: '1280×800 (pipeline)' },
  authoring: { width: 1920, height: 1080, label: '1920×1080 (authoring)' },
};

const WORKHORSE_LEAK_PATTERNS = [
  { name: 'Workhorse theme CSS', re: /assets\/themes\/(minimal-white|tokyo-night|dracula|aurora|cyberpunk-neon)\.css/i },
  { name: 'Workhorse runtime.js', re: /\bruntime\.js\b/i },
  { name: 'Workhorse fx-runtime.js', re: /\bfx-runtime\.js\b/i },
  { name: 'Chart.js', re: /\bchart(?:\.min)?\.js\b/i },
  { name: 'data-anim attribute', re: /\bdata-anim\s*=/i },
  { name: 'data-fx attribute', re: /\bdata-fx\s*=/i },
];

function readUtf8(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${file}: ${err.message}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Validate manifest shape.
 * @param {any} manifest
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['Manifest must be a JSON object.'] };
  }
  if (!manifest.title || typeof manifest.title !== 'string') {
    errors.push('Manifest.title (string) is required.');
  }
  if (!Array.isArray(manifest.slides) || manifest.slides.length === 0) {
    errors.push('Manifest.slides[] must be a non-empty array.');
  } else {
    manifest.slides.forEach((slide, idx) => {
      if (!slide || typeof slide !== 'object') {
        errors.push(`slides[${idx}] must be an object.`);
        return;
      }
      if (!slide.id || typeof slide.id !== 'string') {
        errors.push(`slides[${idx}].id (string) is required.`);
      }
      if (!slide.sourceHtml || typeof slide.sourceHtml !== 'string') {
        errors.push(`slides[${idx}].sourceHtml (string) is required — pass the .slide-root inner markup.`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Detect Workhorse leak patterns inside a slide's sourceHtml.
 * Returns warnings (not errors) so exports do not block.
 * @param {string} html
 * @returns {string[]}
 */
function detectLeaks(html) {
  const warnings = [];
  for (const { name, re } of WORKHORSE_LEAK_PATTERNS) {
    if (re.test(html)) warnings.push(name);
  }
  return warnings;
}

/**
 * Copy a directory tree recursively (small dirs only — fonts + logos).
 * @param {string} src
 * @param {string} dest
 */
function copyDirSync(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Build the assembled HTML string.
 * @param {object} opts
 * @param {object} opts.manifest
 * @param {object} opts.canvasProfile
 * @param {boolean} opts.keyboardNav
 * @param {string} opts.colorsAndTypeCss
 * @param {string} opts.slideCss
 * @param {string} opts.contractCss
 */
function buildDeckHtml({ manifest, canvasProfile, keyboardNav, colorsAndTypeCss, slideCss, contractCss }) {
  const { width, height } = canvasProfile;
  const title = escapeHtml(manifest.title);
  const slidesHtml = manifest.slides.map((slide, i) => {
    const attrs = [];
    if (slide.template) attrs.push(`data-slide-template="${escapeAttr(slide.template)}"`);
    if (slide.workhorseLayout) attrs.push(`data-workhorse-layout="${escapeAttr(slide.workhorseLayout)}"`);
    const bg = slide.background ? ` ${escapeAttr(slide.background)}` : '';
    const activeClass = i === 0 ? ' active' : '';
    return [
      `<div data-testid="step-${escapeAttr(slide.id)}" class="step${activeClass}">`,
      `  <div class="slide-root${bg}" ${attrs.join(' ')}>`,
      `    ${indent(slide.sourceHtml, 4)}`,
      `  </div>`,
      `</div>`,
    ].join('\n');
  }).join('\n\n');

  const navScript = keyboardNav ? buildNavScript() : '';
  const navStyle = keyboardNav ? '' : '\n      .step:not(.active) { display: none; }';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style data-export="plaid-deck-tokens">
${colorsAndTypeCss}
  </style>
  <style data-export="plaid-deck-slide">
${slideCss}
  </style>
  <style data-export="plaid-deck-contract">
${contractCss}
  </style>
  <style data-export="plaid-deck-page">
    html, body { background: var(--plaid-ink-900); min-height: 100vh; margin: 0; }
    .step.active { display: flex; align-items: center; justify-content: center; padding: 24px; min-height: 100vh; }
    .slide-root { aspect-ratio: ${width} / ${height}; }${navStyle}
  </style>
</head>
<body>

${slidesHtml}

${navScript}
</body>
</html>
`;
}

function buildNavScript() {
  return `<script>
(function () {
  var steps = Array.from(document.querySelectorAll('.step[data-testid]'));
  if (steps.length === 0) return;
  function activate(idx) {
    steps.forEach(function (s, i) { s.classList.toggle('active', i === idx); });
  }
  var current = steps.findIndex(function (s) { return s.classList.contains('active'); });
  if (current < 0) { current = 0; activate(0); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
      e.preventDefault();
      current = Math.min(steps.length - 1, current + 1);
      activate(current);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      current = Math.max(0, current - 1);
      activate(current);
    }
  });
})();
</script>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(str) {
  return String(str).replace(/["&<>]/g, (c) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function indent(str, n) {
  const pad = ' '.repeat(n);
  return String(str).split('\n').join('\n' + pad);
}

/**
 * Main export function.
 * @param {object} opts
 * @param {string} opts.manifestPath
 * @param {string} opts.outPath
 * @param {'pipeline'|'authoring'} [opts.canvas='pipeline']
 * @param {'static'|'keyboard'} [opts.nav='static']
 * @param {boolean} [opts.dryRun=false]
 * @param {(msg:string)=>void} [opts.logger]
 */
function exportPlaidDeck(opts) {
  const logger = opts.logger || console.log.bind(console);
  const canvas = opts.canvas || 'pipeline';
  const nav = opts.nav || 'static';
  const canvasProfile = CANVAS_PROFILES[canvas];
  if (!canvasProfile) throw new Error(`Unknown canvas profile "${canvas}" (expected pipeline|authoring).`);

  if (!opts.manifestPath || !fs.existsSync(opts.manifestPath)) {
    throw new Error(`Manifest file not found: ${opts.manifestPath}`);
  }
  const manifest = JSON.parse(readUtf8(opts.manifestPath));
  const valid = validateManifest(manifest);
  if (!valid.ok) throw new Error(`Manifest invalid:\n  - ${valid.errors.join('\n  - ')}`);

  // Detect Workhorse leaks in each slide's sourceHtml.
  const leakReport = manifest.slides.map((s) => ({ id: s.id, leaks: detectLeaks(s.sourceHtml) }));
  const totalLeaks = leakReport.reduce((n, r) => n + r.leaks.length, 0);
  if (totalLeaks > 0) {
    logger(`[export-plaid-deck] WARNING: ${totalLeaks} Workhorse leak pattern(s) detected (not blocked, but cleaning is recommended):`);
    for (const r of leakReport) {
      if (r.leaks.length === 0) continue;
      logger(`  - ${r.id}: ${r.leaks.join(', ')}`);
    }
  }

  const colorsAndTypeCss = readUtf8(path.join(SLIDE_TEMPLATE_DIR, 'colors_and_type.css'));
  const slideCss = readUtf8(path.join(SLIDE_TEMPLATE_DIR, 'slide.css'));
  const contractCss = readUtf8(path.join(SLIDE_TEMPLATE_DIR, 'pipeline-slide-contract.css'));

  const html = buildDeckHtml({
    manifest,
    canvasProfile,
    keyboardNav: nav === 'keyboard',
    colorsAndTypeCss,
    slideCss,
    contractCss,
  });

  if (opts.dryRun) {
    return { html, leakReport, canvasProfile, manifest, copied: [] };
  }

  const outDir = path.dirname(path.resolve(opts.outPath));
  ensureDir(outDir);
  fs.writeFileSync(opts.outPath, html, 'utf8');

  // Copy fonts + logos next to the output so colors_and_type.css resolves relative paths.
  const copied = [];
  const fontsSrc = path.join(SLIDE_TEMPLATE_DIR, 'fonts');
  const fontsDest = path.join(outDir, 'fonts');
  if (fs.existsSync(fontsSrc)) {
    copyDirSync(fontsSrc, fontsDest);
    copied.push(fontsDest);
  }
  const logosSrc = path.join(SLIDE_TEMPLATE_DIR, 'assets', 'logos');
  const logosDest = path.join(outDir, 'assets', 'logos');
  if (fs.existsSync(logosSrc)) {
    copyDirSync(logosSrc, logosDest);
    copied.push(logosDest);
  }

  logger(`[export-plaid-deck] Wrote ${opts.outPath}`);
  logger(`[export-plaid-deck] Canvas: ${canvasProfile.label}; Nav: ${nav}; Slides: ${manifest.slides.length}`);
  for (const dest of copied) logger(`[export-plaid-deck] Copied -> ${path.relative(outDir, dest)}`);

  return { html, leakReport, canvasProfile, manifest, copied };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifestPath = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--canvas') out.canvas = argv[++i];
    else if (a === '--nav') out.nav = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/scratch/utils/export-plaid-deck.js [options]

  --manifest <path>      JSON manifest with { title, slides: [{ id, template?, workhorseLayout?, background?, sourceHtml }] }
  --out <path>           Output .html file
  --canvas <profile>     pipeline (1280x800, default) | authoring (1920x1080)
  --nav <mode>           static (default) | keyboard (arrow-key navigation)
  --dry-run              Validate + assemble without writing
  --help                 Show this help

Examples:
  node scripts/scratch/utils/export-plaid-deck.js --manifest decks/q2-roadmap.json --out dist/q2.html
  node scripts/scratch/utils/export-plaid-deck.js --manifest decks/pitch.json --out dist/pitch.html --canvas authoring --nav keyboard
`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.manifestPath || !args.outPath) {
    console.error('Error: --manifest and --out are required.\n');
    printHelp();
    process.exit(1);
  }
  try {
    exportPlaidDeck(args);
  } catch (err) {
    console.error(`[export-plaid-deck] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  exportPlaidDeck,
  validateManifest,
  detectLeaks,
  buildDeckHtml,
  CANVAS_PROFILES,
  WORKHORSE_LEAK_PATTERNS,
};
