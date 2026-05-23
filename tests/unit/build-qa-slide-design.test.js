'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const bq = require(path.join(__dirname, '../../scripts/scratch/scratch/build-qa'));

const SLIDE_SHELL_OK = `
<div data-testid="step-summary" class="step">
  <div class="slide-root" data-slide-template="T3">
    <div class="frame">
      <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="" />
      <div class="eyebrow-tag">Section 1 — Story</div>
      <h2 class="h-title">From data to <em>intelligence.</em></h2>
      <p style="font-size:30px">Body copy.</p>
      <div class="chrome-foot"><span>01 / 05</span></div>
    </div>
  </div>
</div>`;

describe('slide design scanners', () => {
  test('scanSlideDesignTokens warns when tokens missing', () => {
    const d = bq.scanSlideDesignTokens('<div class="slide-root">no tokens</div>');
    assert.equal(d.length, 1);
    assert.equal(d[0].severity, 'warning');
    assert.equal(d[0].deterministicBlocker, false);
    assert.equal(d[0].category, 'slide-design-tokens');
  });

  test('scanSlideDesignTokens passes when palette tokens present', () => {
    const html = SLIDE_SHELL_OK + '<style>:root{--plaid-ink-900:#022544;--plaid-teal-500:#42F0CD}</style>';
    assert.equal(bq.scanSlideDesignTokens(html).length, 0);
  });

  test('scanSlideShellChrome flags missing chrome', () => {
    const html = `
<div data-testid="step-a" class="step"><div class="slide-root" data-slide-template="T3">
  <div class="frame"><h2 class="h-title">Title <em>x</em></h2></div>
</div></div>`;
    const d = bq.scanSlideShellChrome(html, ['a']);
    assert.ok(d.some((x) => x.category === 'slide-shell-chrome'));
    assert.equal(d[0].severity, 'warning');
  });

  test('scanSlideShellChrome passes canonical shell', () => {
    assert.equal(bq.scanSlideShellChrome(SLIDE_SHELL_OK, ['summary']).length, 0);
  });

  test('scanSlideTypographyFloor flags sub-24px inline font-size', () => {
    const html = `<div class="slide-root"><p style="font-size:18px">Small</p></div>`;
    const d = bq.scanSlideTypographyFloor(html);
    assert.ok(d.length >= 1);
    assert.equal(d[0].category, 'slide-typography-floor');
  });

  test('scanSlideTypographyCeiling flags oversized hero stat', () => {
    const html = `
<div data-testid="step-n" class="step"><div class="slide-root" data-slide-template="T4">
  <div class="hero-stat-value" style="font-size:240px">+25%</div>
</div></div>`;
    const d = bq.scanSlideTypographyCeiling(html);
    assert.ok(d.some((x) => x.category === 'slide-typography-ceiling'));
    assert.equal(d[0].severity, 'warning');
  });

  test('scanSlideHeadlineItalicAccent requires em in h-title', () => {
    const html = `
<div data-testid="step-x" class="step"><div class="slide-root" data-slide-template="T3">
  <div class="frame"><h2 class="h-title">No accent here.</h2></div>
</div></div>`;
    const d = bq.scanSlideHeadlineItalicAccent(html, ['x']);
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'slide-headline-accent');
  });

  test('scanSlideMintOveruse warns above three mint references', () => {
    const html = `
<div data-testid="step-m" class="step"><div class="slide-root">
  <span style="color:#42F0CD">a</span><span style="color:var(--plaid-teal-500)">b</span>
  <span>#42F0CD</span><span>--plaid-teal-500</span>
</div></div>`;
    const d = bq.scanSlideMintOveruse(html, ['m']);
    assert.ok(d.length >= 1);
    assert.equal(d[0].category, 'slide-mint-overuse');
  });

  test('scanSlideInlineBlockLayout flags inline-block under slide-root', () => {
    const html = '<style>.slide-root .row { display: inline-block; }</style><div class="slide-root"></div>';
    const d = bq.scanSlideInlineBlockLayout(html);
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'slide-inline-block');
  });

  test('scanSlideBackgroundRhythm warns after 4 consecutive navy slides', () => {
    const script = {
      steps: [
        { id: 's1', sceneType: 'slide' },
        { id: 's2', sceneType: 'slide' },
        { id: 's3', sceneType: 'slide' },
        { id: 's4', sceneType: 'slide' },
        { id: 's5', sceneType: 'slide' },
      ],
    };
    const html = script.steps.map((s) =>
      `<div data-testid="step-${s.id}" class="step"><div class="slide-root"></div></div>`
    ).join('');
    const d = bq.scanSlideBackgroundRhythm(script, html);
    assert.equal(d.length, 1);
    assert.equal(d[0].category, 'slide-background-rhythm');
  });

  test('scanSlideInventedColors flags unknown hex', () => {
    const html = '<div class="slide-root"><span style="color:#ABCDEF">x</span></div>';
    const d = bq.scanSlideInventedColors(html);
    assert.ok(d.some((x) => x.category === 'slide-invented-color'));
  });

  test('scanSlideDesignSystem allows warnings and logo blockers', () => {
    const script = { steps: [{ id: 'bad', sceneType: 'slide' }] };
    const html = '<div data-testid="step-bad" class="step"><div class="slide-root"></div></div>';
    const d = bq.scanSlideDesignSystem(html, script);
    assert.ok(d.length > 0);
    assert.ok(d.some((x) => x.severity === 'warning' && !x.deterministicBlocker));
    assert.ok(!d.some((x) => x.category.startsWith('slide-plaid-logo')));
  });

  test('isCanonicalSlidePlaidLogoSrc accepts bundled wordmarks only', () => {
    assert.equal(bq.isCanonicalSlidePlaidLogoSrc('assets/logos/plaid-horizontal-white.png'), true);
    assert.equal(bq.isCanonicalSlidePlaidLogoSrc('./assets/logos/plaid-horizontal-dark.png'), true);
    assert.equal(bq.isCanonicalSlidePlaidLogoSrc('assets/logos/plaid-icon-white.png'), false);
    assert.equal(bq.isCanonicalSlidePlaidLogoSrc('plaid-logo-horizontal.png'), false);
  });

  test('scanSlidePlaidLogoAuthenticity passes canonical img chrome-logo', () => {
    const d = bq.scanSlidePlaidLogoAuthenticity(SLIDE_SHELL_OK, ['summary']);
    assert.equal(d.length, 0);
  });

  test('scanSlidePlaidLogoAuthenticity passes when chrome-logo omitted', () => {
    const html = `
<div data-testid="step-t1" class="step"><div class="slide-root" data-slide-template="T1">
  <div class="frame"><h2 class="h-title">Title <em>accent.</em></h2></div>
</div></div>`;
    assert.equal(bq.scanSlidePlaidLogoAuthenticity(html, ['t1']).length, 0);
  });

  test('scanSlidePlaidLogoAuthenticity blocks invented div+PLAID text logo', () => {
    const html = `
<div data-testid="step-fake" class="step"><div class="slide-root" data-slide-template="T3">
  <div class="frame">
    <div class="chrome-logo"><span class="logo-icon"></span><span>PLAID</span></div>
    <div class="eyebrow-tag">Section</div>
    <h2 class="h-title">Approve <em>more.</em></h2>
  </div>
</div></div>`;
    const d = bq.scanSlidePlaidLogoAuthenticity(html, ['fake']);
    assert.ok(d.some((x) => x.category === 'slide-plaid-logo-invented'));
    assert.equal(d[0].severity, 'critical');
    assert.equal(d[0].deterministicBlocker, true);
  });

  test('scanSlidePlaidLogoAuthenticity blocks legacy plaid-logo path', () => {
    const html = `
<div data-testid="step-leg" class="step"><div class="slide-root">
  <div class="frame">
    <img class="chrome-logo" src="./plaid-logo-horizontal-black-white-background.png" alt="" />
    <h2 class="h-title">Headline <em>accent.</em></h2>
  </div>
</div></div>`;
    const d = bq.scanSlidePlaidLogoAuthenticity(html, ['leg']);
    assert.ok(d.some((x) => x.category === 'slide-plaid-logo-noncanonical'));
  });

  test('scanSlidePlaidLogoAuthenticity blocks icon-only asset on chrome-logo', () => {
    const html = `
<div data-testid="step-icon" class="step"><div class="slide-root">
  <div class="frame">
    <img class="chrome-logo" src="assets/logos/plaid-icon-white.png" alt="" />
    <h2 class="h-title">Headline <em>accent.</em></h2>
  </div>
</div></div>`;
    const d = bq.scanSlidePlaidLogoAuthenticity(html, ['icon']);
    assert.ok(d.some((x) => x.category === 'slide-plaid-logo-noncanonical'));
  });
});
