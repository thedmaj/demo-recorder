'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  PLAID_LINK_BASE_MAX_MS: 15000,
  PLAID_LINK_OVER_15_BUFFER_MS: 500,
  NARRATION_SYNC_TOLERANCE_MS: 250,
};

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function createTimingContract({
  runDir = '',
  source = 'auto-gap',
  generatedAt = new Date().toISOString(),
  steps = [],
  syncMapSegments = [],
  policy = {},
  toleranceMs = DEFAULTS.NARRATION_SYNC_TOLERANCE_MS,
} = {}) {
  const normalized = (Array.isArray(steps) ? steps : []).map((s) => {
    const targetCompDurationMs = Math.max(0, toNumber(s.targetMs));
    const actualCompDurationMs = Math.max(
      0,
      toNumber(s.actualCompDurationMs, toNumber(s.compEndMs) - toNumber(s.compStartMs))
    );
    const narrationDurationMs = Math.max(0, toNumber(s.narrationMs));
    const videoDurationMs = Math.max(0, toNumber(s.videoDurationMs));
    const gapMs = Math.max(0, toNumber(s.gapMs));
    const deltaMs = Math.round(actualCompDurationMs - targetCompDurationMs);
    const status = actualCompDurationMs + toleranceMs >= targetCompDurationMs ? 'ok' : 'overrun';
    const isPlaidLink = s.isPlaidLink === true;
    return {
      stepId: s.stepId || '',
      isPlaidLink,
      plaidLinkPolicy: s.plaidLinkPolicy || (isPlaidLink ? 'default' : null),
      narrationDurationMs: Math.round(narrationDurationMs),
      videoDurationMs: Math.round(videoDurationMs),
      gapMs: Math.round(gapMs),
      targetCompDurationMs: Math.round(targetCompDurationMs),
      actualCompDurationMs: Math.round(actualCompDurationMs),
      deltaMs,
      status,
      action: s.action || null,
      compStartMs: Math.round(toNumber(s.compStartMs)),
      compEndMs: Math.round(toNumber(s.compEndMs)),
    };
  });

  const violations = normalized.filter((s) => s.status !== 'ok');
  const plaidRows = normalized.filter((s) => s.isPlaidLink);
  const summary = {
    totalSteps: normalized.length,
    okSteps: normalized.length - violations.length,
    overrunSteps: violations.length,
    plaidLinkSteps: plaidRows.length,
    plaidLinkOverruns: plaidRows.filter((s) => s.status !== 'ok').length,
    maxOverrunMs: violations.reduce((m, s) => Math.max(m, Math.abs(s.deltaMs)), 0),
  };

  return {
    generatedAt,
    source,
    runDir,
    defaults: {
      PLAID_LINK_BASE_MAX_MS: toNumber(policy.PLAID_LINK_BASE_MAX_MS, DEFAULTS.PLAID_LINK_BASE_MAX_MS),
      PLAID_LINK_OVER_15_BUFFER_MS: toNumber(policy.PLAID_LINK_OVER_15_BUFFER_MS, DEFAULTS.PLAID_LINK_OVER_15_BUFFER_MS),
      NARRATION_SYNC_TOLERANCE_MS: toNumber(toleranceMs, DEFAULTS.NARRATION_SYNC_TOLERANCE_MS),
    },
    summary,
    syncMapSegmentCount: Array.isArray(syncMapSegments) ? syncMapSegments.length : 0,
    steps: normalized,
  };
}

function writeTimingContract(runDir, contract, fileName = 'timing-contract.json') {
  const outPath = path.join(runDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(contract, null, 2), 'utf8');
  return outPath;
}

function loadTimingContract(runDir, fileName = 'timing-contract.json') {
  const inPath = path.join(runDir, fileName);
  if (!fs.existsSync(inPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(inPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULTS,
  createTimingContract,
  writeTimingContract,
  loadTimingContract,
};
