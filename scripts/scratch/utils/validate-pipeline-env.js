'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PREFIX = '[env-check]';

/**
 * @param {string} raw
 * @param {string} projectRoot
 * @returns {string}
 */
function expandCredentialPath(raw, projectRoot) {
  let p = String(raw || '').trim();
  if (!p) return '';
  if (p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(2));
  } else if (p === '~') {
    p = os.homedir();
  }
  if (!path.isAbsolute(p)) {
    p = path.resolve(projectRoot, p);
  }
  return path.normalize(p);
}

/**
 * @param {string} apiKey
 * @returns {Promise<{ ok: boolean, detail?: string, warning?: string }>}
 */
async function pingAnthropic(apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const txt = await res.text();
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: `Anthropic API rejected the key (HTTP ${res.status}).` };
  }
  if (res.status === 429) {
    return { ok: true, warning: 'Anthropic rate-limited this check (429) — key may still be valid.' };
  }
  if (!res.ok) {
    return {
      ok: false,
      detail: `Anthropic HTTP ${res.status}: ${txt.slice(0, 240)}`,
    };
  }
  return { ok: true };
}

/**
 * @param {{ projectRoot?: string, skipLiveCheck?: boolean }} [opts]
 */
async function validatePipelineEnv(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const skipLiveCheck =
    opts.skipLiveCheck === true ||
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK === 'true' ||
    process.env.PIPELINE_SKIP_ENV_LIVE_CHECK === '1';

  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (
    process.env.PIPELINE_SKIP_ENV_CHECK === 'true' ||
    process.env.PIPELINE_SKIP_ENV_CHECK === '1'
  ) {
    return {
      ok: true,
      skipped: true,
      errors: [],
      warnings: [],
      messages: ['PIPELINE_SKIP_ENV_CHECK set — skipped environment validation.'],
    };
  }

  const anthropic =
    process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim();
  if (!anthropic) {
    errors.push('ANTHROPIC_API_KEY is missing or empty (required for the pipeline LLM).');
  }

  // Google embeddings now use GOOGLE_API_KEY (gemini-embedding-2 via the Gemini
  // API) — no GCP service-account JSON / ADC. No service-account credentials are
  // validated here anymore.

  const plaidEnv = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  if (plaidEnv === 'sandbox') {
    if (!process.env.PLAID_CLIENT_ID || !String(process.env.PLAID_CLIENT_ID).trim()) {
      warnings.push('PLAID_CLIENT_ID is empty — Link token creation will fail until set.');
    }
    if (!process.env.PLAID_SANDBOX_SECRET || !String(process.env.PLAID_SANDBOX_SECRET).trim()) {
      warnings.push('PLAID_SANDBOX_SECRET is empty — Plaid API calls will fail until set.');
    }
  }

  if (!process.env.ELEVENLABS_API_KEY || !String(process.env.ELEVENLABS_API_KEY).trim()) {
    warnings.push('ELEVENLABS_API_KEY is empty — voiceover stages will fail until set.');
  }

  if (!process.env.GOOGLE_API_KEY || !String(process.env.GOOGLE_API_KEY).trim()) {
    warnings.push('GOOGLE_API_KEY is empty — embedding stages (embed-script-validate, embed-sync) fall back to Haiku / skip.');
  }

  if (anthropic && !skipLiveCheck) {
    try {
      const ping = await pingAnthropic(anthropic);
      if (!ping.ok) {
        errors.push(ping.detail || 'Anthropic key validation failed.');
      } else if (ping.warning) {
        warnings.push(ping.warning);
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      warnings.push(`Could not reach Anthropic API to verify the key (network): ${msg}`);
    }
  } else if (anthropic && skipLiveCheck) {
    warnings.push('Skipped live Anthropic key check (PIPELINE_SKIP_ENV_LIVE_CHECK).');
  }

  const ok = errors.length === 0;
  return { ok, errors, warnings };
}

/**
 * @param {Awaited<ReturnType<typeof validatePipelineEnv>>} result
 * @param {{ log?: (...args: string[]) => void, warn?: (...args: string[]) => void, error?: (...args: string[]) => void }} [io]
 */
function printValidationReport(result, io = {}) {
  const log = io.log || ((...a) => console.log(...a));
  const warn = io.warn || ((...a) => console.warn(...a));
  const err = io.error || ((...a) => console.error(...a));

  log('');
  log(`${PREFIX} Environment validation`);
  if (result.skipped) {
    for (const m of result.messages || []) {
      warn(`${PREFIX} ${m}`);
    }
    log('');
    return;
  }
  if (result.errors && result.errors.length) {
    for (const e of result.errors) {
      err(`${PREFIX} ✗ ${e}`);
    }
  }
  if (result.warnings && result.warnings.length) {
    for (const w of result.warnings) {
      warn(`${PREFIX} ! ${w}`);
    }
  }
  if (result.ok) {
    const suffix =
      result.warnings && result.warnings.length ? ' (see warnings above)' : '';
    log(`${PREFIX} ✓ Required checks passed${suffix}.`);
  }
  log('');
}

module.exports = {
  validatePipelineEnv,
  printValidationReport,
  expandCredentialPath,
  PREFIX,
};
