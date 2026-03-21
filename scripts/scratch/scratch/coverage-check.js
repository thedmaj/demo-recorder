#!/usr/bin/env node
'use strict';
/**
 * coverage-check.js
 * Computes narration coverage: what % of demo-script steps and words
 * made it into the voiceover manifest (and therefore the final video).
 *
 * Flags steps whose narration was scripted but not voiced.
 * Runs after voiceover stage, before audio-qa.
 *
 * Writes: {runDir}/coverage-report.json
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');

async function main() {
  const scriptFile   = path.join(OUT_DIR, 'demo-script.json');
  const manifestFile = path.join(OUT_DIR, 'voiceover-manifest.json');

  if (!fs.existsSync(scriptFile)) {
    console.log('[coverage-check] No demo-script.json — skipping.');
    return { coverage: null, skipped: true };
  }
  if (!fs.existsSync(manifestFile)) {
    console.log('[coverage-check] No voiceover-manifest.json — skipping.');
    return { coverage: null, skipped: true };
  }

  const script   = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const clips    = manifest.clips || manifest;

  const manifestIds = new Set(clips.map(c => c.stepId || c.id));
  const steps       = script.steps || [];

  const results = steps.map(step => {
    const narration  = (step.narration || '').trim();
    const words      = narration ? narration.split(/\s+/).filter(Boolean).length : 0;
    const inVoice    = manifestIds.has(step.id);
    return { id: step.id, words, inVoice, narration: narration.substring(0, 80) };
  });

  const totalSteps    = results.length;
  const voicedSteps   = results.filter(r => r.inVoice).length;
  const totalWords    = results.reduce((s, r) => s + r.words, 0);
  const voicedWords   = results.filter(r => r.inVoice).reduce((s, r) => s + r.words, 0);
  const missingSteps  = results.filter(r => !r.inVoice && r.words > 0);

  const stepCoverage = totalSteps  ? Math.round((voicedSteps / totalSteps) * 100)  : 100;
  const wordCoverage = totalWords  ? Math.round((voicedWords / totalWords) * 100)  : 100;

  console.log(`[coverage-check] Step coverage: ${voicedSteps}/${totalSteps} (${stepCoverage}%)`);
  console.log(`[coverage-check] Word coverage: ${voicedWords}/${totalWords} words (${wordCoverage}%)`);

  if (missingSteps.length > 0) {
    console.warn(`[coverage-check] ${missingSteps.length} step(s) have scripted narration but NO voiceover:`);
    for (const s of missingSteps) {
      console.warn(`  [${s.id}]  ${s.words} words — "${s.narration}${s.narration.length >= 80 ? '...' : ''}"`);
    }
    if (missingSteps.some(s => !/link/.test(s.id))) {
      console.error('[coverage-check] WARNING: Non-Plaid-Link steps are missing voiceover — review the manifest.');
    } else {
      console.log('[coverage-check] All missing steps are Plaid Link steps (expected for PLAID_LINK_LIVE=true).');
    }
  } else {
    console.log('[coverage-check] 100% narration coverage — all scripted steps have voiceover.');
  }

  const report = {
    generatedAt:  new Date().toISOString(),
    stepCoverage, wordCoverage,
    totalSteps,   voicedSteps,
    totalWords,   voicedWords,
    missingSteps: missingSteps.map(s => ({ id: s.id, words: s.words, narration: s.narration })),
    steps:        results,
  };

  const reportPath = path.join(OUT_DIR, 'coverage-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[coverage-check] Report: ${reportPath}`);

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[coverage-check] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
