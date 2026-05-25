'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  pickDarkWordmarkUrl,
  applyHostNavLogoContrastPatch,
  isLogoNavLuminanceCollision,
  collisionIssueText,
  HOST_NAV_CONTRAST_MARKER,
} = require(path.join(__dirname, '../../scripts/scratch/utils/host-nav-logo-contrast'));

describe('host-nav-logo-contrast', () => {
  test('pickDarkWordmarkUrl prefers /theme/light/ URL', () => {
    const brand = {
      logo: {
        imageUrl: 'https://cdn.brandfetch.io/x/theme/dark/logo.svg',
        iconUrl: 'https://cdn.brandfetch.io/x/theme/light/wordmark.svg',
      },
    };
    assert.match(pickDarkWordmarkUrl(brand), /\/theme\/light\//);
  });

  test('isLogoNavLuminanceCollision detects dark wordmark on dark nav', () => {
    assert.equal(
      isLogoNavLuminanceCollision({
        logoSrc: 'https://cdn.brandfetch.io/a/theme/light/logo.svg',
        navBgLuminance: 0.12,
      }),
      true
    );
  });

  test('isLogoNavLuminanceCollision passes on white nav + dark wordmark', () => {
    assert.equal(
      isLogoNavLuminanceCollision({
        logoSrc: 'https://cdn.brandfetch.io/a/theme/light/logo.svg',
        navBgLuminance: 0.95,
      }),
      false
    );
  });

  test('applyHostNavLogoContrastPatch injects CSS and swaps logo src', () => {
    const brand = {
      colors: { navAccentStripe: '#034F54', accentCta: '#034F54' },
      logo: {
        imageUrl: 'https://cdn.brandfetch.io/h/theme/dark/logo.svg',
      },
    };
    const html = `<!doctype html><html><head><style>nav{background:#222}</style></head><body>
<header><div data-testid="host-bank-logo-shell">
<img data-testid="host-bank-logo-img" src="https://cdn.brandfetch.io/h/theme/dark/logo.svg" alt="Bank">
</div></header></body></html>`;
    const out = applyHostNavLogoContrastPatch(html, brand);
    assert.equal(out.applied, true);
    assert.ok(out.cssInjected);
    assert.ok(out.html.includes(HOST_NAV_CONTRAST_MARKER));
    assert.match(out.html, /background-color:\s*#ffffff\s*!important/);
    assert.match(out.html, /border-bottom:\s*2px solid #034F54/);
    assert.match(out.html, /theme\/light\//);
    assert.doesNotMatch(out.html, /theme\/dark\/logo\.svg/);
  });

  test('applyHostNavLogoContrastPatch is idempotent', () => {
    const brand = { colors: { accentCta: '#00a67e' }, logo: { imageUrl: 'https://x/theme/light/a.svg' } };
    const html = `<html><head><style></style></head><body>
<img data-testid="host-bank-logo-img" src="https://x/theme/light/a.svg"></body></html>`;
    const first = applyHostNavLogoContrastPatch(html, brand);
    const second = applyHostNavLogoContrastPatch(first.html, brand);
    assert.equal(second.applied, false);
  });
});

describe('qa-patch-library host-nav-logo-contrast', () => {
  test('findApplicablePatches matches host-logo-contrast category', () => {
    const lib = require(path.join(__dirname, '../../scripts/scratch/utils/qa-patch-library'));
    const matches = lib.findApplicablePatches({
      steps: [
        {
          stepId: 'intro',
          categories: ['host-logo-contrast'],
          issues: ['Host logo contrast failure: dark wordmark on dark navigation background'],
        },
      ],
    });
    assert.ok(matches.some((m) => m.patch.name === 'host-nav-logo-contrast'));
  });

  test('patch applies to scratch-app without build-app', async () => {
    const lib = require(path.join(__dirname, '../../scripts/scratch/utils/qa-patch-library'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-nav-patch-'));
    const appDir = path.join(dir, 'scratch-app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'artifacts', 'brand'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'artifacts', 'brand', 'huntington.json'),
      JSON.stringify({
        colors: { accentCta: '#034F54' },
        logo: { imageUrl: 'https://cdn.brandfetch.io/h/theme/dark/logo.svg' },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(appDir, 'index.html'),
      `<html><head><style></style></head><body><header style="background:#1a1a1a">
<img data-testid="host-bank-logo-img" src="https://cdn.brandfetch.io/h/theme/dark/logo.svg"></header></body></html>`,
      'utf8'
    );
    const match = lib.findApplicablePatches({
      steps: [{ stepId: 'intro', categories: ['host-logo-contrast'], issues: [] }],
    }).find((m) => m.patch.name === 'host-nav-logo-contrast');
    assert.ok(match);
    const r = await lib.applyPatches({ runDir: dir, matches: [match], iteration: 'test' });
    assert.equal(r.applied, 1);
    const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
    assert.ok(html.includes(HOST_NAV_CONTRAST_MARKER));
  });
});

describe('qa-tier-summary patchable blockers', () => {
  test('host-logo-contrast alone does not force fullbuild via systemic gate', () => {
    const { computeTierSummary } = require(path.join(
      __dirname,
      '../../scripts/scratch/utils/qa-tier-summary'
    ));
    const qaReport = {
      passThreshold: 80,
      buildMode: 'app-only',
      overallScore: 70,
      deterministicGateEnabled: true,
      deterministicPassed: false,
      deterministicReasons: ['host-logo-contrast'],
      steps: [
        {
          stepId: 'intro',
          score: 70,
          critical: true,
          categories: ['host-logo-contrast'],
        },
      ],
    };
    const demoScript = {
      steps: [{ id: 'intro', stepKind: 'app', sceneType: 'host' }],
    };
    const out = computeTierSummary(qaReport, demoScript, { buildMode: 'app-only' });
    assert.equal(out.recommendedRecovery, 'app-touchup');
    assert.ok(!out.systemicReasons.includes('deterministic_blocker_gate'));
  });
});
