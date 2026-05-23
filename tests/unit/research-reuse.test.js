'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  shouldReuseExistingResearch,
} = require(path.join(__dirname, '../../scripts/scratch/utils/research-reuse'));

// Tiny injectable fingerprint stub so tests don't depend on the real
// implementation (which already has its own tests).
function fingerprintStub(text) {
  if (!text) return '';
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}`;
}

function makeRunDir({ cachedFingerprint, missingFingerprint, missingFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-reuse-'));
  if (!missingFile) {
    const payload = {
      generatedAt: new Date().toISOString(),
    };
    if (!missingFingerprint) payload.inputPromptFingerprint = cachedFingerprint || 'fp-default';
    fs.writeFileSync(path.join(dir, 'product-research.json'), JSON.stringify(payload), 'utf8');
  }
  return dir;
}

beforeEach(() => {
  // Reset env between tests so each starts from the "default-on" behavior.
  delete process.env.RESEARCH_REUSE;
});

// ── Default-on behavior ─────────────────────────────────────────────────────

describe('shouldReuseExistingResearch — default-on (no env)', () => {
  test('reuses when artifact exists and fingerprint matches', () => {
    const prompt = 'demo prompt for Betterment Investments Move';
    const fp = fingerprintStub(prompt);
    const dir = makeRunDir({ cachedFingerprint: fp });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: prompt,
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, true);
    assert.equal(out.reason, 'fingerprint_match');
  });

  test('does not reuse when fingerprint differs (prompt changed)', () => {
    const dir = makeRunDir({ cachedFingerprint: 'fp-OLD' });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: 'NEW prompt that produces a different fingerprint',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'prompt_fingerprint_mismatch');
  });

  test('does not reuse when product-research.json is missing', () => {
    const dir = makeRunDir({ missingFile: true });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: 'any',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'no_existing_research_artifact');
  });

  test('does not reuse when cached artifact lacks inputPromptFingerprint', () => {
    const dir = makeRunDir({ missingFingerprint: true });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: 'any',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'cached_research_missing_fingerprint');
  });
});

// ── Explicit override paths ────────────────────────────────────────────────

describe('shouldReuseExistingResearch — explicit overrides', () => {
  test('RESEARCH_REUSE=false forces a fresh pass even on fingerprint match', () => {
    process.env.RESEARCH_REUSE = 'false';
    const prompt = 'demo';
    const fp = fingerprintStub(prompt);
    const dir = makeRunDir({ cachedFingerprint: fp });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: prompt,
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'env_research_reuse_false');
  });

  test('--from=research disables reuse regardless of env / fingerprint', () => {
    const prompt = 'demo';
    const fp = fingerprintStub(prompt);
    const dir = makeRunDir({ cachedFingerprint: fp });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: prompt,
      effectiveFromStage: 'research',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'explicit_from_research');
  });
});

// ── Guard paths ─────────────────────────────────────────────────────────────

describe('shouldReuseExistingResearch — guards', () => {
  test('no run dir → no reuse', () => {
    const out = shouldReuseExistingResearch({
      runDir: '',
      promptText: 'x',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'no_run_dir');
  });

  test('empty prompt → no reuse', () => {
    const dir = makeRunDir({ cachedFingerprint: 'fp-x' });
    const out = shouldReuseExistingResearch({
      runDir: dir,
      promptText: '',
      fingerprintPrompt: fingerprintStub,
    });
    assert.equal(out.shouldReuse, false);
    assert.equal(out.reason, 'empty_prompt_fingerprint');
  });
});
