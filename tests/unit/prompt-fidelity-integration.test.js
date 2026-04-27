'use strict';
// Integration tests for the prompt-fidelity wiring:
//   - The stage script (`scripts/scratch/scratch/prompt-fidelity-check.js`)
//     reads the right files, writes the right reports, and emits the right
//     pipe events.
//   - `buildScriptGenerationPrompt` branches on the storyboard tier (verbatim
//     / scenario-derived / generic) and emits the right narrative-arc block.
//
// We don't test the orchestrator's continue-gate end-to-end (that requires a
// real subprocess + signal file). The wiring there is a thin call to
// `promptContinue`, which is already covered by the existing continue-gate
// machinery.

const { test, describe, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STAGE_PATH = path.join(__dirname, '../../scripts/scratch/scratch/prompt-fidelity-check');
const PROMPT_TEMPLATES_PATH = path.join(__dirname, '../../scripts/scratch/utils/prompt-templates');

let stage;
let promptTemplates;

before(() => {
  // Stage script reads PIPELINE_RUN_DIR at module load via require('dotenv').config.
  // We override it per-test by setting env before invoking main().
  process.env.PIPELINE_RUN_DIR ||= path.join(os.tmpdir(), 'pf-integration-stub');
  stage = require(STAGE_PATH);
  promptTemplates = require(PROMPT_TEMPLATES_PATH);
});

function mkRunDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-run-'));
  fs.mkdirSync(path.join(base, 'inputs'), { recursive: true });
  return base;
}

function seedPrompt(runDir, content) {
  fs.writeFileSync(path.join(runDir, 'inputs', 'prompt.txt'), content, 'utf8');
}
function seedScript(runDir, script) {
  fs.writeFileSync(path.join(runDir, 'demo-script.json'), JSON.stringify(script, null, 2));
}

// ─── Stage smoke ────────────────────────────────────────────────────────────

describe('prompt-fidelity-check stage', () => {
  beforeEach(() => {
    // Wipe agent-mode envs so we can opt into them per-test.
    delete process.env.PIPE_AGENT_MODE;
    delete process.env.CLAUDECODE;
    delete process.env.SCRATCH_AUTO_APPROVE;
  });

  test('writes report + skips task md when entities and script align', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    seedPrompt(runDir,
      'Company: Acme\n' +
      'Persona: Jane Doe, customer\n' +
      'Products: Auth\n' +
      'Plaid Link mode: modal\n' +
      'Use case: Jane verifies her account before transfer.\n'
    );
    seedScript(runDir, {
      persona: { name: 'Jane Doe', company: 'Acme' },
      plaidLinkMode: 'modal',
      steps: [
        { id: 'home', label: 'Home', visualState: 'Home', narration: 'Jane opens Acme.' },
        { id: 'link', label: 'Connect', visualState: 'Plaid', narration: 'Plaid Auth verifies.' },
      ],
    });
    const report = await stage.main();
    assert.equal(report.comparison.passed, true);
    assert.ok(fs.existsSync(path.join(runDir, 'prompt-fidelity-report.json')));
    assert.ok(!fs.existsSync(path.join(runDir, 'prompt-fidelity-task.md')));
  });

  test('writes task md when critical drift exists, even in non-agent mode', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    seedPrompt(runDir, 'Company: Bank of America\nProducts: Auth, Identity Match');
    seedScript(runDir, {
      persona: { name: 'Sarah', company: 'Capital One' },
      plaidLinkMode: 'modal',
      steps: [{ id: 'home', label: 'Home', visualState: 'Home', narration: 'Sarah opens her bank.' }],
    });
    const report = await stage.main();
    assert.equal(report.comparison.passed, false);
    assert.ok(report.comparison.criticalCount >= 1);
    const taskPath = path.join(runDir, 'prompt-fidelity-task.md');
    assert.ok(fs.existsSync(taskPath));
    const taskMd = fs.readFileSync(taskPath, 'utf8');
    assert.match(taskMd, /brand-mismatch/);
  });

  test('orchestratorDriven CTA appears when in agent mode + critical drift', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    process.env.PIPE_AGENT_MODE = '1';
    seedPrompt(runDir, 'Company: Bank of America\nProducts: Auth');
    seedScript(runDir, {
      persona: { company: 'Capital One' },
      steps: [{ id: 'home', visualState: '', narration: '' }],
    });
    await stage.main();
    const taskMd = fs.readFileSync(path.join(runDir, 'prompt-fidelity-task.md'), 'utf8');
    assert.match(taskMd, /paused on a continue-gate/);
    assert.match(taskMd, /npm run pipe -- continue/);
    delete process.env.PIPE_AGENT_MODE;
  });

  test('skips gracefully when prompt.txt or demo-script.json is missing', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    // No files seeded.
    const report = await stage.main();
    assert.equal(report.passed, true);
    assert.equal(report.skipped, true);
  });

  test('captures storyboard tier in the report', async () => {
    const runDir = mkRunDir();
    process.env.PIPELINE_RUN_DIR = runDir;
    seedPrompt(runDir,
      '**Company:** Acme\n' +
      '**Products used:** Auth\n\n' +
      '## Storyboard\n' +
      '1. User opens app\n' +
      '2. User clicks connect\n' +
      '3. User confirms\n'
    );
    seedScript(runDir, {
      persona: { name: 'Anyone', company: 'Acme' },
      steps: [
        { id: 's1', visualState: 'a', narration: 'Plaid Auth confirms.' },
        { id: 's2', visualState: 'b', narration: 'Plaid Auth confirms.' },
        { id: 's3', visualState: 'c', narration: 'Plaid Auth confirms.' },
      ],
    });
    const report = await stage.main();
    assert.equal(report.storyboardTier.tier, 'verbatim');
    assert.equal(report.storyboardTier.beatCount, 3);
  });
});

// ─── buildScriptGenerationPrompt branching ──────────────────────────────────

function makeIngested(promptText) {
  return { texts: [{ filename: 'prompt.txt', content: promptText }], screenshots: [], transcriptions: [] };
}

const STUB_RESEARCH = {
  synthesizedInsights: 'Some insights.',
  pipelineRunContext: null,
  solutionsMasterContext: null,
  plaidLinkMode: 'modal',
  plaidLinkUxSkillMarkdown: '',
  embeddedLinkSkillMarkdown: '',
  accurateTerminology: {},
  internalKnowledge: [],
};

describe('buildScriptGenerationPrompt — three-tier story handling', () => {
  test('TIER verbatim: emits "USER-PROVIDED STORYBOARD" block + numbered beats', () => {
    const promptText =
      '**Company:** Acme\n' +
      '**Products used:** Auth\n\n' +
      '## Storyboard\n' +
      '1. User opens dashboard\n' +
      '2. User clicks Connect\n' +
      '3. User completes Plaid Link\n' +
      '4. User sees verified card\n';
    const { system } = promptTemplates.buildScriptGenerationPrompt(
      makeIngested(promptText), STUB_RESEARCH
    );
    assert.match(system, /USER-PROVIDED STORYBOARD/);
    assert.match(system, /Map exactly one demo-script step per beat|map exactly one demo-script step per beat/);
    assert.match(system, /User's beats \(4 total/);
    assert.match(system, /1\. User opens dashboard/);
    assert.doesNotMatch(system, /^Narrative arc \(always follow\):/m);
  });

  test('TIER scenario-derived: emits "SCENARIO-DERIVED STORYBOARD" block with use-case spine', () => {
    const promptText =
      '**Company:** Bank of America\n' +
      '**Products used:** Auth, Identity Match\n' +
      '**Use case (user pitch):** BofA wants to verify external account ownership before allowing high-value ACH transfers, without micro-deposits.\n';
    const { system } = promptTemplates.buildScriptGenerationPrompt(
      makeIngested(promptText), STUB_RESEARCH
    );
    assert.match(system, /SCENARIO-DERIVED STORYBOARD/);
    assert.match(system, /User's scenario \(treat as the spine of the narrative\)/);
    assert.match(system, /BofA wants to verify external account ownership/);
    assert.match(system, /Canonical arc structure \(apply to the user's scenario\)/);
    assert.doesNotMatch(system, /USER-PROVIDED STORYBOARD/);
  });

  test('TIER generic: falls back to canonical "Narrative arc (always follow):" block', () => {
    // Bare prompt — only brand, no products, no scenario:
    const { system } = promptTemplates.buildScriptGenerationPrompt(
      makeIngested('Company: Acme\nMake a demo.'), STUB_RESEARCH
    );
    assert.match(system, /Narrative arc \(always follow\):/);
    assert.doesNotMatch(system, /USER-PROVIDED STORYBOARD/);
    assert.doesNotMatch(system, /SCENARIO-DERIVED STORYBOARD/);
  });

  test('quality standards (20-35 words, 8-14 steps) are present in all three tiers', () => {
    const tiers = [
      // verbatim
      '**Company:** Acme\n**Products:** Auth\n## Storyboard\n1. a\n2. b\n3. c',
      // scenario-derived
      '**Company:** Acme\n**Products used:** Auth\n**Use case:** A scenario describing what the user wants to demonstrate end to end.',
      // generic
      'Company: Acme',
    ];
    for (const promptText of tiers) {
      const { system } = promptTemplates.buildScriptGenerationPrompt(
        makeIngested(promptText), STUB_RESEARCH
      );
      assert.match(system, /20[\u2013-]35 words/);
    }
  });
});
