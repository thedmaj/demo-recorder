'use strict';
// Regression suite (2026-07-01) for two Gringo full-build failures:
//
// 1) MULTI-LAUNCH interaction: enforceCanonicalLaunchInteraction used .find() and
//    normalized only the FIRST plaidPhase:"launch" step. In an IDV + bank-Link
//    demo the second launch kept the LLM's {action:"wait"} interaction, so the
//    recorder never CLICKED the bank CTA → modal never opened → onSuccess never
//    fired → PLAID_LINK_MODAL_MISSING. Now every launch is normalized to click
//    with a product-aware, DISTINCT target (idv-launch-btn vs link-external-account-btn).
//
// 2) TRACKER host-chrome: a bare `<div class="progress" id="progress">` host
//    stepper was not tagged host-app-chrome (the tagger only matched compound
//    step-/progress- class names), so it bled onto full-bleed slides. markHostAppChrome
//    now tags bare progress/steps classes AND id-based trackers.
const test = require('node:test');
const assert = require('node:assert');
const { enforceCanonicalLaunchInteraction } = require('../../scripts/scratch/scratch/generate-script');
const { markHostAppChrome } = require('../../scripts/scratch/scratch/post-panels');

test('multi-launch: BOTH launch steps get action=click (not wait)', () => {
  const script = {
    plaidLinkMode: 'modal',
    steps: [
      { id: 'idv-launch', plaidPhase: 'launch', label: 'Confirm your identity (IDV)',
        interaction: { action: 'click', target: 'link-external-account-btn', waitMs: 120000 } },
      { id: 'idv-verdict-insight', sceneType: 'insight' },
      { id: 'bank-link-launch', plaidPhase: 'launch', label: 'Connect your funding account',
        interaction: { action: 'wait', target: 'plaid-link-modal', waitMs: 3000 } },
    ],
  };
  enforceCanonicalLaunchInteraction(script);
  const idv = script.steps.find((s) => s.id === 'idv-launch');
  const bank = script.steps.find((s) => s.id === 'bank-link-launch');
  assert.equal(idv.interaction.action, 'click');
  assert.equal(bank.interaction.action, 'click', 'second launch must be click, not wait');
  // Distinct targets so the build never stamps a duplicate data-testid.
  assert.equal(idv.interaction.target, 'idv-launch-btn', 'IDV launch → idv-launch-btn');
  assert.equal(bank.interaction.target, 'link-external-account-btn', 'bank launch → link CTA');
  assert.notStrictEqual(idv.interaction.target, bank.interaction.target);
});

test('single-launch behavior unchanged (click + link CTA)', () => {
  const script = { plaidLinkMode: 'modal', steps: [
    { id: 'plaid-link-launch', plaidPhase: 'launch', label: 'Link your bank' },
  ] };
  enforceCanonicalLaunchInteraction(script);
  const s = script.steps[0];
  assert.equal(s.interaction.action, 'click');
  assert.equal(s.interaction.target, 'link-external-account-btn');
  assert.equal(s.interaction.waitMs, 120000);
});

test('embedded mode: all launches use goToStep with own id', () => {
  const script = { plaidLinkMode: 'embedded', steps: [
    { id: 'add-external-account-embedded', plaidPhase: 'launch' },
  ] };
  enforceCanonicalLaunchInteraction(script);
  assert.equal(script.steps[0].interaction.action, 'goToStep');
  assert.equal(script.steps[0].interaction.target, 'add-external-account-embedded');
});

test('slide-typed launch steps are skipped', () => {
  const script = { plaidLinkMode: 'modal', steps: [
    { id: 'slidey', plaidPhase: 'launch', sceneType: 'slide', interaction: { action: 'goToStep', target: 'slidey' } },
  ] };
  enforceCanonicalLaunchInteraction(script);
  assert.equal(script.steps[0].interaction.action, 'goToStep', 'slide launch untouched');
});

test('tracker chrome: bare .progress + #progress tracker is tagged host-app-chrome', () => {
  const out = markHostAppChrome('<div class="progress" id="progress"></div>');
  assert.match(out, /class="progress host-app-chrome"/);
});

test('tracker chrome: id-only tracker (no class) gets a host-app-chrome class', () => {
  const out = markHostAppChrome('<div id="stepper"></div>');
  assert.match(out, /class="host-app-chrome"/);
});

test('tracker chrome: nav tagging still works; slide primitives untouched', () => {
  assert.match(markHostAppChrome('<header class="nav"></header>'), /nav host-app-chrome/);
  const slide = markHostAppChrome('<div class="sc-field-row"><span class="sc-field-key">A</span></div>');
  assert.doesNotMatch(slide, /host-app-chrome/, 'slide primitives must not be tagged as host chrome');
});
