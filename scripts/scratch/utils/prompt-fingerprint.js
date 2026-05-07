'use strict';

/**
 * Shared prompt fingerprint for research reuse and run-manifest alignment.
 * Must match orchestrator normalize + hash behavior.
 */

const crypto = require('crypto');

function normalizePromptForFingerprint(promptText) {
  return String(promptText || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function fingerprintPrompt(promptText) {
  const normalized = normalizePromptForFingerprint(promptText);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = {
  normalizePromptForFingerprint,
  fingerprintPrompt,
};
