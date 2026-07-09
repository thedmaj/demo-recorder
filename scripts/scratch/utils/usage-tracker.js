'use strict';
/**
 * usage-tracker.js — per-run Claude token + cost accounting.
 *
 * install() monkeypatches the shared @anthropic-ai/sdk Messages prototypes
 * (both `client.messages` and `client.beta.messages`, `create` + `stream`) once,
 * so EVERY Claude call across all in-process pipeline stages is captured with no
 * per-call-site wiring. setContext({runDir}) chooses the output file;
 * setStage(name) tags subsequent calls. Writes <runDir>/usage.json:
 *   { calls:[{stage,model,input_tokens,output_tokens,cache_read,cache_write,cost_usd,at}],
 *     totals:{ inputTokens, outputTokens, costUsd, byStage:{}, byModel:{} } }
 *
 * Pricing is $/1M tokens (input, output). Cache read ≈ 0.1× input, cache write
 * (5m) ≈ 1.25× input (standard Anthropic multipliers). Unknown models fall back
 * to Opus-tier rates. Non-Claude spend (ElevenLabs, Gemini) is NOT tracked here.
 */
const fs = require('fs');
const path = require('path');

const PRICES = {
  'claude-fable-5':   { in: 10, out: 50 },
  'claude-mythos-5':  { in: 10, out: 50 },
  'claude-opus-4-8':  { in: 5,  out: 25 },
  'claude-opus-4-7':  { in: 5,  out: 25 },
  'claude-opus-4-6':  { in: 5,  out: 25 },
  'claude-sonnet-4-6':{ in: 3,  out: 15 },
  'claude-sonnet-4-5':{ in: 3,  out: 15 },
  'claude-haiku-4-5': { in: 1,  out: 5  },
};
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  for (const key of Object.keys(PRICES)) if (m.startsWith(key)) return PRICES[key];
  if (m.includes('fable') || m.includes('mythos')) return PRICES['claude-fable-5'];
  if (m.includes('opus')) return PRICES['claude-opus-4-8'];
  if (m.includes('sonnet')) return PRICES['claude-sonnet-4-6'];
  if (m.includes('haiku')) return PRICES['claude-haiku-4-5'];
  return PRICES['claude-opus-4-8']; // conservative default
}

let _installed = false;
let _ctx = { runDir: null, stage: 'unknown' };
const _calls = [];

function setContext({ runDir } = {}) { if (runDir) _ctx.runDir = runDir; }
function setStage(stage) { if (stage) _ctx.stage = String(stage); }

function round(n) { return Math.round(n * 1e6) / 1e6; }

function summarize() {
  const totals = { calls: _calls.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, byStage: {}, byModel: {} };
  for (const c of _calls) {
    totals.inputTokens += c.input_tokens; totals.outputTokens += c.output_tokens;
    totals.cacheReadTokens += c.cache_read; totals.cacheWriteTokens += c.cache_write;
    totals.costUsd += c.cost_usd;
    totals.byStage[c.stage] = round((totals.byStage[c.stage] || 0) + c.cost_usd);
    totals.byModel[c.model] = round((totals.byModel[c.model] || 0) + c.cost_usd);
  }
  totals.costUsd = round(totals.costUsd);
  return { calls: _calls, totals };
}

function writeUsage() {
  if (!_ctx.runDir) return;
  try {
    fs.writeFileSync(path.join(_ctx.runDir, 'usage.json'), JSON.stringify(summarize(), null, 2), 'utf8');
  } catch (_) { /* best-effort — never break a build over accounting */ }
}

function record(model, usage) {
  if (!usage) return;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const p = priceFor(model);
  const cost = (inTok * p.in + outTok * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6;
  _calls.push({
    stage: _ctx.stage || 'unknown',
    model: String(model || 'unknown'),
    input_tokens: inTok, output_tokens: outTok,
    cache_read: cacheRead, cache_write: cacheWrite,
    cost_usd: round(cost),
  });
  writeUsage();
}

function install() {
  if (_installed) return;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { return; }
  let probe;
  try { probe = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'usage-tracker-probe' }); } catch (_) { return; }

  const patchProto = (inst) => {
    if (!inst) return;
    const proto = Object.getPrototypeOf(inst);
    if (!proto || proto.__usagePatched) return;
    proto.__usagePatched = true;
    const origCreate = proto.create;
    if (typeof origCreate === 'function') {
      proto.create = function (...args) {
        const model = args[0] && args[0].model;
        const out = origCreate.apply(this, args);
        if (out && typeof out.then === 'function') {
          out.then((msg) => { try { if (msg && msg.usage) record(msg.model || model, msg.usage); } catch (_) {} }, () => {});
        }
        return out;
      };
    }
    const origStream = proto.stream;
    if (typeof origStream === 'function') {
      proto.stream = function (...args) {
        const model = args[0] && args[0].model;
        const stream = origStream.apply(this, args);
        try {
          if (stream && typeof stream.on === 'function') {
            stream.on('finalMessage', (msg) => { try { if (msg && msg.usage) record(msg.model || model, msg.usage); } catch (_) {} });
          }
        } catch (_) {}
        return stream;
      };
    }
  };

  try { patchProto(probe.messages); } catch (_) {}
  try { patchProto(probe.beta && probe.beta.messages); } catch (_) {}
  _installed = true;
}

module.exports = { install, setContext, setStage, priceFor, PRICES };
