'use strict';
/**
 * Brandfetch Brand Context API (https://api.brandfetch.io/v2/context/{domain}).
 *
 * Returns a compact, LLM-ready brief about the HOST company (identity/mission/
 * description, positioning/value-proposition/target-audience/products, brand voice)
 * — the context the research phase otherwise lacks (AskBill/Glean only know Plaid +
 * internal data, not what the customer company actually does). Used to ground the
 * demo persona, scenario, and value-prop language in the real business.
 *
 * Flagged + fully graceful: no BRANDFETCH_API_KEY, no brand domain, or any HTTP/parse
 * error → returns null and the pipeline proceeds unchanged. Per-domain disk cache
 * avoids re-spending quota across runs.
 */
const fs = require('fs');
const path = require('path');

const CACHE_FILE = process.env.BRAND_CONTEXT_CACHE ||
  path.resolve(__dirname, '..', '..', '..', 'inputs', 'brand-context-cache.json');
const ENDPOINT = 'https://api.brandfetch.io/v2/context';

/** Infer the host brand domain from the prompt: explicit "Brand URL:" / "Canonical URL:" first, else the first plausible non-Plaid/non-infra https URL. */
function inferBrandDomainFromPrompt(promptText) {
  if (!promptText || typeof promptText !== 'string') return null;
  const explicit = promptText.match(/(?:Brand URL|Canonical URL)\b[^\n:]*:\s*(https?:\/\/[^\s)\]]+)/i);
  let url = explicit ? explicit[1] : null;
  if (!url) {
    const urls = promptText.match(/https?:\/\/[^\s)\]]+/g) || [];
    url = urls.find((u) => !/(plaid\.com|plaid\.dev|docs\.|cdn\.|github\.|brandfetch\.|googleusercontent|youtube|linkedin)/i.test(u));
  }
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function readCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function writeCache(c) { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch (_) {} }

/**
 * Fetch the Brand Context brief for a domain. Returns a markdown string (default) or
 * null. `format`: 'markdown' (Accept: text/markdown — compact, prompt-ready) | 'json'.
 */
async function fetchBrandContext(domain, { format = 'markdown', timeoutMs = 15000, useCache = true } = {}) {
  if (!domain) return null;
  const key = process.env.BRANDFETCH_API_KEY;
  if (!key) { console.warn('[brand-context] BRANDFETCH_API_KEY unset — skipping host-company context.'); return null; }

  const cacheKey = `${domain}:${format}`;
  const cache = readCache();
  if (useCache && cache[cacheKey] && cache[cacheKey].body) {
    console.log(`[brand-context] cache hit: ${domain}`);
    return cache[cacheKey].body;
  }

  const accept = format === 'json' ? 'application/json' : 'text/markdown';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: accept },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[brand-context] ${domain}: HTTP ${res.status} — skipping host-company context.`); return null; }
    const body = await res.text();
    if (!body || body.trim().length < 50) { console.warn(`[brand-context] ${domain}: empty/short response — skipping.`); return null; }
    cache[cacheKey] = { body, fetchedAt: new Date().toISOString() };
    writeCache(cache);
    console.log(`[brand-context] fetched ${domain} (${Math.round(body.length / 1024)}KB, ${format}).`);
    return body;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[brand-context] ${domain}: fetch error (${e.message}) — skipping host-company context.`);
    return null;
  }
}

module.exports = { fetchBrandContext, inferBrandDomainFromPrompt };
