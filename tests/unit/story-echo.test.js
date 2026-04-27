'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SE = require(path.join(__dirname, '../../scripts/scratch/utils/story-echo'));

// ─── buildStoryEchoMessages ──────────────────────────────────────────────────

describe('buildStoryEchoMessages', () => {
  test('embeds prompt, transcript, and step outline in the user message', () => {
    const { system, userText } = SE.buildStoryEchoMessages(
      'Pitch: BofA wants to verify external accounts before transfers.',
      'Michael Carter opens BofA. He clicks Connect. Plaid Auth verifies his account.',
      {
        persona: { name: 'Michael Carter', company: 'Bank of America' },
        plaidLinkMode: 'embedded',
        steps: [
          { id: 'home', label: 'Home dashboard' },
          { id: 'launch', label: 'Plaid Link launch' },
          { id: 'verified', label: 'Verified card' },
        ],
      }
    );
    assert.match(system, /You are reviewing whether a finished demo video tells the story/);
    assert.match(userText, /USER'S ORIGINAL PITCH/);
    assert.match(userText, /VOICEOVER TRANSCRIPT/);
    assert.match(userText, /VIDEO OUTLINE/);
    assert.match(userText, /1\. Home dashboard/);
    assert.match(userText, /BofA wants to verify external accounts/);
    assert.match(userText, /Bank of America/);
  });

  test('caps prompt + transcript size to keep prompt under budget', () => {
    const huge = 'x'.repeat(20000);
    const { userText } = SE.buildStoryEchoMessages(huge, huge, { steps: [] });
    // prompt cap 6000, transcript cap 8000 — total user text should be well under 20K.
    assert.ok(userText.length < 18000, `userText was ${userText.length} chars`);
  });

  test('handles missing demoScript / persona gracefully', () => {
    const { userText } = SE.buildStoryEchoMessages('pitch', 'transcript', null);
    assert.match(userText, /\(no steps\)/);
    assert.match(userText, /Persona: \(unset\)/);
  });
});

// ─── parseStoryEchoResponse ──────────────────────────────────────────────────

describe('parseStoryEchoResponse', () => {
  test('parses a clean JSON response and computes passed', () => {
    const raw = JSON.stringify({
      score: 92,
      summary: 'Voiceover answers the pitch end-to-end.',
      drifts: [],
    });
    const out = SE.parseStoryEchoResponse(raw);
    assert.equal(out.score, 92);
    assert.equal(out.passed, true);
    assert.equal(out.criticalCount, 0);
  });

  test('parses fenced JSON output (```json ... ```)', () => {
    const raw = '```json\n' + JSON.stringify({ score: 70, drifts: [] }) + '\n```';
    const out = SE.parseStoryEchoResponse(raw);
    assert.equal(out.score, 70);
  });

  test('counts critical vs warning drifts and applies threshold gate', () => {
    const raw = JSON.stringify({
      score: 95,
      summary: 'Mostly fine, but persona drifts.',
      drifts: [
        { kind: 'persona-drift', severity: 'critical', evidence: 'Voiceover says "Sarah" but pitch said "Michael"', suggestion: 'Rename in narration' },
        { kind: 'pacing', severity: 'warning', evidence: '...', suggestion: '...' },
      ],
    });
    const out = SE.parseStoryEchoResponse(raw);
    // High score but a critical drift → not passed.
    assert.equal(out.passed, false);
    assert.equal(out.criticalCount, 1);
    assert.equal(out.warningCount, 1);
  });

  test('passes only when score ≥ threshold AND zero critical drifts', () => {
    const raw = JSON.stringify({ score: 88, drifts: [] });
    assert.equal(SE.parseStoryEchoResponse(raw, { threshold: 88 }).passed, true);
    assert.equal(SE.parseStoryEchoResponse(raw, { threshold: 90 }).passed, false);
  });

  test('floors score at 0 and caps at 100', () => {
    assert.equal(SE.parseStoryEchoResponse('{"score": 200}').score, 100);
    assert.equal(SE.parseStoryEchoResponse('{"score": -10}').score, 0);
  });

  test('returns parseError on invalid JSON', () => {
    const out = SE.parseStoryEchoResponse('not json');
    assert.equal(out.score, 0);
    assert.equal(out.passed, false);
    assert.ok(out.parseError);
  });

  test('handles empty / null input', () => {
    const a = SE.parseStoryEchoResponse('');
    const b = SE.parseStoryEchoResponse(null);
    assert.equal(a.score, 0);
    assert.equal(a.parseError, 'empty-response');
    assert.equal(b.score, 0);
  });

  test('drops malformed drifts (missing kind/severity)', () => {
    const raw = JSON.stringify({
      score: 60,
      drifts: [
        { kind: 'good', severity: 'warning', evidence: 'x' },
        { evidence: 'no kind' },
        { kind: 'no severity' },
      ],
    });
    const out = SE.parseStoryEchoResponse(raw);
    assert.equal(out.drifts.length, 1);
    assert.equal(out.drifts[0].kind, 'good');
  });
});

// ─── collateVoiceoverTranscript ──────────────────────────────────────────────

describe('collateVoiceoverTranscript', () => {
  test('concatenates manifest entries in step order', () => {
    const manifest = {
      entries: [
        { stepId: 'home',   transcript: 'Michael opens BofA.' },
        { stepId: 'launch', transcript: 'He connects via Plaid.' },
        { stepId: 'verify', transcript: 'Account verified.' },
      ],
    };
    const demoScript = {
      steps: [
        { id: 'home' }, { id: 'launch' }, { id: 'verify' },
      ],
    };
    const out = SE.collateVoiceoverTranscript(manifest, demoScript);
    assert.equal(out, 'Michael opens BofA. He connects via Plaid. Account verified.');
  });

  test('falls back to demo-script narration when manifest lacks transcript', () => {
    const manifest = { entries: [{ stepId: 'a' /* no transcript */ }] };
    const demoScript = { steps: [{ id: 'a', narration: 'Fallback narration text.' }] };
    const out = SE.collateVoiceoverTranscript(manifest, demoScript);
    assert.equal(out, 'Fallback narration text.');
  });

  test('handles object-shaped manifest (keyed by stepId)', () => {
    const manifest = { home: { transcript: 'Hello.' }, link: { transcript: 'World.' } };
    const demoScript = { steps: [{ id: 'home' }, { id: 'link' }] };
    const out = SE.collateVoiceoverTranscript(manifest, demoScript);
    assert.equal(out, 'Hello. World.');
  });

  test('returns empty string when no manifest or steps', () => {
    assert.equal(SE.collateVoiceoverTranscript(null, null), '');
    assert.equal(SE.collateVoiceoverTranscript({}, { steps: [] }), '');
  });
});

// ─── buildStoryEchoFixTask ───────────────────────────────────────────────────

describe('buildStoryEchoFixTask', () => {
  test('renders agent-task md with score, drifts, and orchestrator-driven CTA', () => {
    const md = SE.buildStoryEchoFixTask({
      runId: 'run-1',
      report: {
        score: 70,
        threshold: 88,
        summary: 'Brand never mentioned.',
        drifts: [
          { kind: 'brand-not-mentioned', severity: 'critical', evidence: 'No "Bank of America" anywhere.', suggestion: 'Add brand name to opening narration.' },
        ],
        criticalCount: 1,
        warningCount: 0,
      },
      opts: { orchestratorDriven: true },
    });
    assert.match(md, /^# Story-echo drift — run-1/);
    assert.match(md, /paused on a continue-gate/);
    assert.match(md, /npm run pipe -- continue run-1/);
    assert.match(md, /brand-not-mentioned/);
  });

  test('renders standalone CTA when not orchestrator-driven', () => {
    const md = SE.buildStoryEchoFixTask({
      runId: 'run-1',
      report: { score: 70, threshold: 88, drifts: [], criticalCount: 0, warningCount: 0 },
    });
    assert.match(md, /npm run pipe -- stage voiceover run-1/);
    assert.doesNotMatch(md, /continue run-1/);
  });

  test('handles empty drifts array gracefully', () => {
    const md = SE.buildStoryEchoFixTask({
      runId: 'run-1',
      report: { score: 80, threshold: 88, drifts: [] },
    });
    assert.match(md, /no per-drift entries/);
  });
});

// ─── gradeStoryEcho — skip behavior (no API key) ────────────────────────────

describe('gradeStoryEcho (skip path)', () => {
  test('returns skipped result when ANTHROPIC_API_KEY is missing', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const out = await SE.gradeStoryEcho('pitch', 'transcript', { steps: [] });
      assert.equal(out.skipped, true);
      assert.equal(out.reason, 'no-anthropic-key');
      // Skip should not block the pipeline:
      assert.equal(out.passed, true);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
