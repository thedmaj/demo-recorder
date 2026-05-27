'use strict';

/**
 * Unit tests for scanSlideTextOverlap + qa-patch-library
 * slide-text-overlap-autofix.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanSlideTextOverlap,
} = require('../../scripts/scratch/scratch/build-qa');

const { PATCHES, findApplicablePatches, applyPatches } = require('../../scripts/scratch/utils/qa-patch-library');

function slideStep(id = 'plaid-summary-slide') {
  return { id, stepKind: 'slide', sceneType: 'slide' };
}

function makeOverlap({ aFs = 96, bFs = 48, area = 2400 } = {}) {
  return {
    a: { tag: 'H2', text: 'Plaid is everywhere.', fontSize: aFs, rect: { x: 100, y: 200, w: 800, h: 120 } },
    b: { tag: 'P', text: 'Supporting body text', fontSize: bFs, rect: { x: 120, y: 240, w: 700, h: 60 } },
    overlapArea: area,
    overlapW: Math.round(Math.sqrt(area)),
    overlapH: Math.round(Math.sqrt(area)),
  };
}

// ── scanSlideTextOverlap ─────────────────────────────────────────────────────

test('scanSlideTextOverlap: empty state -> []', () => {
  const out = scanSlideTextOverlap({ slideTextOverlaps: [] }, slideStep());
  assert.deepEqual(out, []);
});

test('scanSlideTextOverlap: non-slide step -> []', () => {
  const out = scanSlideTextOverlap({ slideTextOverlaps: [makeOverlap()] }, { id: 'host-step', stepKind: 'app' });
  assert.deepEqual(out, []);
});

test('scanSlideTextOverlap: single overlap -> critical diagnostic with meta + recommendation', () => {
  const out = scanSlideTextOverlap({ slideTextOverlaps: [makeOverlap({ aFs: 96 })] }, slideStep());
  assert.equal(out.length, 1);
  const d = out[0];
  assert.equal(d.category, 'slide-text-overlap');
  assert.equal(d.severity, 'critical');
  assert.equal(d.deterministicBlocker, true);
  assert.equal(d.stepId, 'plaid-summary-slide');
  assert.match(d.issue, /overlap/i);
  // 96 * 0.75 = 72; rounded to multiple of 2 -> 72
  assert.equal(d.meta.recommendedFontSizePx, 72);
  assert.equal(d.meta.a.fontSize, 96);
});

test('scanSlideTextOverlap: 24px floor REMOVED 2026-05-27 — small fonts reduce further if needed', () => {
  const out = scanSlideTextOverlap({
    slideTextOverlaps: [makeOverlap({ aFs: 24, bFs: 24 })],
  }, slideStep());
  assert.equal(out.length, 1);
  // 24 * 0.75 = 18; no floor at 24 anymore — recommendation is 18px (rounded to even)
  assert.equal(out[0].meta.recommendedFontSizePx, 18);
  // Suggestion still describes reducing the larger element (no "already at floor" branch).
  assert.match(out[0].suggestion, /Reduce font-size/);
});

test('scanSlideTextOverlap: more than 6 overlaps -> warning collapse', () => {
  const many = Array.from({ length: 9 }, (_, i) => makeOverlap({ area: 2400 + i }));
  const out = scanSlideTextOverlap({ slideTextOverlaps: many }, slideStep());
  // 6 criticals + 1 summary warning
  assert.equal(out.length, 7);
  assert.equal(out[6].severity, 'warning');
  assert.match(out[6].issue, /3 additional text-overlap pair/);
});

// ── slide-text-overlap-autofix patch ─────────────────────────────────────────

test('qa-patch-library exports slide-text-overlap-autofix', () => {
  const p = PATCHES.find((x) => x.name === 'slide-text-overlap-autofix');
  assert.ok(p, 'patch is registered');
  assert.deepEqual(p.matchCategories, ['slide-text-overlap']);
  assert.equal(p.tierScope, 'slide');
});

test('findApplicablePatches matches slide-text-overlap-autofix on qa report', () => {
  const qaReport = {
    steps: [
      {
        stepId: 'plaid-summary-slide',
        categories: ['slide-text-overlap'],
        issues: ['Text elements overlap on slide.'],
      },
    ],
  };
  const matches = findApplicablePatches(qaReport);
  const m = matches.find((x) => x.patch.name === 'slide-text-overlap-autofix');
  assert.ok(m, 'overlap autofix selected');
  assert.deepEqual(m.matchedCategories, ['slide-text-overlap']);
});

test('slide-text-overlap-autofix.apply: injects scoped CSS reduction and gap rule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-autofix-'));
  try {
    fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
    const indexPath = path.join(dir, 'scratch-app', 'index.html');
    fs.writeFileSync(indexPath, '<!doctype html><html><head><title>x</title></head><body><div class="step" data-testid="step-plaid-summary-slide"><div class="slide-root"><h2 class="h-title">Big.</h2></div></div></body></html>');

    const diagnostics = [
      {
        stepId: 'plaid-summary-slide',
        category: 'slide-text-overlap',
        severity: 'critical',
        meta: {
          a: { tag: 'H2', fontSize: 96 },
          b: { tag: 'P', fontSize: 30 },
          recommendedFontSizePx: 72,
        },
      },
    ];
    fs.writeFileSync(path.join(dir, 'build-qa-diagnostics.json'), JSON.stringify(diagnostics));

    const patch = PATCHES.find((x) => x.name === 'slide-text-overlap-autofix');
    const result = await patch.apply({ runDir: dir });

    assert.equal(result.applied, true);
    const html = fs.readFileSync(indexPath, 'utf8');
    assert.match(html, /data-pipeline-overlap-autofix="v1"/);
    // Larger side (H2 96px) gets reduced to 72px target
    assert.match(html, /\[data-testid="step-plaid-summary-slide"\] \.slide-root h2 \{ font-size: 72px/);
    // Gap rule applied
    assert.match(html, /\.slide-stack \{ gap: clamp/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slide-text-overlap-autofix.apply: 24px floor removed — patch still applies when target reduces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-autofix-'));
  try {
    fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), '<html><head></head><body><div class="step" data-testid="step-plaid-summary-slide"><div class="slide-root"><p>tight.</p><span>caption</span></div></div></body></html>');
    const diagnostics = [
      {
        stepId: 'plaid-summary-slide',
        category: 'slide-text-overlap',
        meta: {
          a: { tag: 'P', fontSize: 24 },
          b: { tag: 'SPAN', fontSize: 24 },
          recommendedFontSizePx: 18,
        },
      },
    ];
    fs.writeFileSync(path.join(dir, 'build-qa-diagnostics.json'), JSON.stringify(diagnostics));

    const patch = PATCHES.find((x) => x.name === 'slide-text-overlap-autofix');
    const result = await patch.apply({ runDir: dir });

    // 24px floor removed 2026-05-27 — the 18px target now reduces the
    // larger element, so the patch applies instead of skipping.
    assert.equal(result.applied, true);
    const html = fs.readFileSync(path.join(dir, 'scratch-app', 'index.html'), 'utf8');
    assert.match(html, /font-size: 18px/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slide-text-overlap-autofix.apply: missing build-qa-diagnostics.json -> no-op', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-autofix-'));
  try {
    fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), '<html></html>');
    const patch = PATCHES.find((x) => x.name === 'slide-text-overlap-autofix');
    const result = await patch.apply({ runDir: dir });
    assert.equal(result.applied, false);
    assert.match(result.summary, /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
