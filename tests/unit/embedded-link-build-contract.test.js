/**
 * Contract checks on build-app embedded Link normalization (no require of main()).
 */
const fs = require('fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const BUILD_APP = path.join(__dirname, '../../scripts/scratch/scratch/build-app.js');

test('embedded size is single default profile (430×390) meeting Plaid minimums', () => {
  const src = fs.readFileSync(BUILD_APP, 'utf8');
  const m = src.match(/default:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/);
  assert.ok(m, 'EMBEDDED_LINK_SIZE_PROFILES.default');
  const width = Number(m[1]);
  const height = Number(m[2]);
  const meetsPlaidMin =
    (width >= 350 && height >= 300) || (width >= 300 && height >= 350);
  assert.ok(meetsPlaidMin, 'default should satisfy 350×300 or 300×350 minimum');
  assert.strictEqual(width, 430);
  assert.strictEqual(height, 390);
  assert.ok(!/\bsmall:\s*\{/.test(src), 'no small profile entry');
  assert.ok(!/\bmedium:\s*\{/.test(src), 'no medium profile entry');
  assert.ok(!/\blarge:\s*\{/.test(src), 'no large profile entry');
  assert.ok(
    /function resolveEmbeddedLinkSizeProfile\([\s\S]*?return\s*['"]default['"]/m.test(src),
    'resolver should always return default profile key'
  );
});

test('applyEmbeddedContainerSizing strips overflow hidden from container rule', () => {
  const src = fs.readFileSync(BUILD_APP, 'utf8');
  assert.ok(
    src.includes('.replace(/\\boverflow(?:-x|-y)?\\s*:\\s*hidden\\s*;?/gi'),
    'cleaned rule body should drop overflow:hidden variants'
  );
});

test('embedded container sizing sets explicit height for iframe default (150px)', () => {
  const src = fs.readFileSync(BUILD_APP, 'utf8');
  assert.ok(
    /height:\$\{height\}px/.test(src),
    'applyEmbeddedContainerSizing should set height alongside min-height'
  );
  assert.ok(
    src.includes("container.style.height = _embH"),
    'layout shim should set height on the embed container'
  );
});

test('runtime sizing uses resolveEmbeddedRuntimeSizingProfile', () => {
  const src = fs.readFileSync(BUILD_APP, 'utf8');
  assert.ok(
    src.includes('function resolveEmbeddedRuntimeSizingProfile('),
    'runtime shim should align with resolveEmbeddedLinkSizeProfile'
  );
  assert.ok(
    src.includes('resolveEmbeddedRuntimeSizingProfile(html, demoScript, promptText)'),
    'injectEmbeddedLinkRuntimeHandler should use unified resolver'
  );
});

test('skill documents unified 430×390, overflow, and iframe 150px default', () => {
  const skillPath = path.join(__dirname, '../../skills/plaid-link-embedded-link-skill.md');
  const md = fs.readFileSync(skillPath, 'utf8');
  assert.match(md, /overflow:\s*hidden/);
  assert.match(md, /430/);
  assert.match(md, /390/);
  assert.match(md, /150px/);
  assert.match(md, /__embeddedLinkSizeProfile = 'default'/);
});
