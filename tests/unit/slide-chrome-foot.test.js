'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripChromeFootFromHtml } = require('../../scripts/scratch/utils/slide-chrome-foot');

test('stripChromeFootFromHtml removes chrome-foot blocks', () => {
  const html = `
<div class="slide-root">
  <div class="frame">
    <h2 class="h-title">Title</h2>
    <div class="chrome-foot"><span>Plaid × Tilt · Protect</span></div>
  </div>
</div>`;
  const out = stripChromeFootFromHtml(html);
  assert.ok(!/\bchrome-foot\b/.test(out));
  assert.ok(/Title/.test(out));
});

test('stripChromeFootFromHtml is idempotent', () => {
  const html = '<div class="chrome-foot"><span>x</span></div><p>body</p>';
  const once = stripChromeFootFromHtml(html);
  assert.equal(stripChromeFootFromHtml(once), once);
});
