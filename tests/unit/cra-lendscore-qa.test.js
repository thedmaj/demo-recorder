'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.PIPELINE_RUN_DIR ||= path.join(__dirname, '../../out');

const bq = require(path.join(__dirname, '../../scripts/scratch/scratch/build-qa'));
const BF = require(path.join(__dirname, '../../scripts/scratch/utils/brand-fidelity'));
const ps = require(path.join(__dirname, '../../scripts/scratch/utils/prompt-scope'));

describe('CRA LendScore contracts', () => {
  test('looksLikeMarketingNav detects Zip mega-menu scrape', () => {
    const items = [
      { label: 'Affiliate' },
      { label: 'Pricing' },
      { label: 'Store DirectoryFind a Store' },
      { label: 'Gift CardsGive the gift of choice' },
    ];
    assert.equal(BF.looksLikeMarketingNav(items), true);
  });

  test('detectProductSlugFromPrompt maps cra_lend_score to cra-lend-score', () => {
    const slug = ps.detectProductSlugFromPrompt('**Primary product family**: `cra_lend_score`');
    assert.equal(slug, 'cra-lend-score');
  });

  test('evaluateApiStoryAlignment accepts lend_score endpoint with lend_score JSON', () => {
    const step = {
      id: 'lendscore-reveal',
      visualState: 'Base Report summary days_available 731 LendScore 78',
      apiResponse: {
        endpoint: 'POST /cra/check_report/lend_score/get',
        response: {
          report: {
            lend_score: { score: 78, reason_codes: ['PCS0221'], score_range: { min: 1, max: 99 } },
          },
        },
      },
    };
    const issues = bq.evaluateApiStoryAlignment(step);
    assert.equal(issues.length, 0, issues.join('; '));
  });

  test('scanCraHostUnderwritingContracts flags missing NMLS and panel reserve', () => {
    const script = {
      steps: [
        {
          id: 'lendscore-reveal',
          stepKind: 'app',
          apiResponse: { endpoint: 'POST /cra/check_report/lend_score/get', response: { report: { lend_score: { score: 78 } } } },
        },
      ],
    };
    const html = `
<div data-testid="step-lendscore-reveal" class="step">
  <div class="underwriting-grid">
    <button data-testid="approve-plan-cta">Approve</button>
    <span>LendScore 78</span>
  </div>
</div>`;
    const d = bq.scanCraHostUnderwritingContracts(html, script);
    assert.ok(d.some((x) => x.category === 'brand-disclosure-missing'));
    assert.ok(d.some((x) => x.category === 'cra-lendscore-host-layout'));
  });

  test('extractStepHtmlBlocks ignores CSS selectors before real step divs', () => {
    const html = `
<style>.step[data-testid="step-lendscore-reveal"] .main { color: red; }</style>
<div data-testid="step-lendscore-reveal" class="step">
  <button data-testid="approve-plan-cta">Go</button>
</div>
<div data-testid="step-other" class="step"></div>`;
    const block = bq.extractStepHtmlBlocks(html, ['lendscore-reveal']).get('lendscore-reveal') || '';
    assert.match(block, /approve-plan-cta/);
    assert.doesNotMatch(block, /^\.step\[/);
  });

  test('scanCraHostUnderwritingContracts passes with NMLS and reserve CSS', () => {
    const script = {
      steps: [
        {
          id: 'lendscore-reveal',
          stepKind: 'app',
          apiResponse: { endpoint: 'POST /cra/check_report/lend_score/get', response: { report: { lend_score: { score: 78 } } } },
        },
      ],
    };
    const html = `
<div data-testid="step-lendscore-reveal" class="step">
  <style>.underwriting-grid { max-width: calc(100% - 520px); }</style>
  <div class="underwriting-grid">
    <button data-testid="approve-plan-cta">Approve plan</button>
    <span>LendScore 78 APPROVE</span>
  </div>
  <div class="zip-host-footer">NMLS ID 1963958</div>
</div>`;
    const d = bq.scanCraHostUnderwritingContracts(html, script);
    assert.equal(d.filter((x) => x.deterministicBlocker).length, 0);
  });
});
