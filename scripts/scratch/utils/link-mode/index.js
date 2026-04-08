'use strict';

const modalAdapter = require('./modal');
const embeddedAdapter = require('./embedded');

function normalizeMode(mode) {
  return String(mode || '').toLowerCase().trim() === 'embedded' ? 'embedded' : 'modal';
}

function detectModeFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return 'modal';
  const embeddedHints = [
    /\bembedded\s+link\b/,
    /\bhosted\s+link\b/,
    /\bembedded[-\s]?clients?\b/,
    /\bpay by bank\b.*\bembedded\b/,
  ];
  return embeddedHints.some((re) => re.test(t)) ? 'embedded' : 'modal';
}

function resolveMode({ explicitMode, demoScript, promptText } = {}) {
  const explicit = normalizeMode(explicitMode || demoScript?.plaidLinkMode);
  if ((explicitMode || demoScript?.plaidLinkMode) != null) return explicit;
  return detectModeFromText(`${promptText || ''}\n${JSON.stringify(demoScript || {})}`);
}

function getLinkModeAdapter(mode) {
  return normalizeMode(mode) === 'embedded' ? embeddedAdapter : modalAdapter;
}

module.exports = {
  normalizeMode,
  detectModeFromText,
  resolveMode,
  getLinkModeAdapter,
};
