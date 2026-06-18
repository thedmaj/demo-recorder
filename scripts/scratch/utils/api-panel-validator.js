'use strict';
/**
 * api-panel-validator.js
 *
 * Pure, tiered validator for the API panel JSON shown on-screen in demo videos
 * (the `apiResponse` blocks in demo-script.json steps — {endpoint, request?,
 * response}). Validates field NAMES / TYPES / SHAPES / format against Plaid's
 * real contracts. NEVER flags curated VALUES (persona names, amounts, scores)
 * — only structural / contract accuracy.
 *
 * Three ground-truth tiers, most-authoritative first:
 *   Tier 1 — live-capture diff: when the run's own artifacts/live-api-responses.json
 *            has a `live:true` real response for the same endpoint, diff the
 *            demo response's field paths/types against it. Catches fabricated
 *            fields and type/nesting mismatches deterministically and free.
 *   Tier 2 — AskBill field list: for endpoints live-capture can't exercise
 *            (async CRA reports, etc.), check demo field NAMES against AskBill's
 *            canonical field list (passed in as a name set; the stage supplies
 *            it from the cache / mcp-clients.askPlaidDocs). Name-membership only.
 *   Tier 3 — deterministic format + per-endpoint shape/value rules (no LLM):
 *            masked Auth account, spaced request_id, ellipsized ids, placeholder
 *            tokens, Signal range/enum, triggered_rule_details object-vs-array.
 *
 * Conservatism: a field is only "fabricated" (HIGH) when absent from ALL
 * available sources. When no ground truth exists for an endpoint, name checks
 * downgrade to LOW/skip — never block on absence of knowledge.
 *
 * This module has NO I/O and NO network — the stage (api-panel-audit.js) loads
 * artifacts and supplies askBill name-sets, so this stays unit-testable.
 */

const SEV = { HIGH: 'HIGH', MED: 'MED', LOW: 'LOW' };

// Documented product-VARIANT fields that ride a shared endpoint and are absent
// from the default sandbox live-capture, so live-diff must NOT flag them as
// fabricated. (EWA / Cash Advance Score adds these to /signal/evaluate; the
// default sandbox capture has no EWA enabled.) Real sub-fabrications inside
// these subtrees are deliberately not chased — conservatism over false positives.
const LIVE_DIFF_EXEMPT = {
  '/signal/evaluate': ['scores.cash_advance', 'core_attributes'],
};

// Per-endpoint allowlist of documented field LEAF names that may legitimately
// appear in a panel but are absent from the captured request/response (e.g.
// optional request options on a request-config panel). Supplements ground
// truth so these aren't flagged as fabricated. Lowercased.
const KNOWN_FIELDS = {
  // /link/token/create panels conventionally show the REQUEST config; the
  // documented request options + response fields vary by product, so allowlist
  // the common documented ones.
  '/link/token/create': [
    'products', 'optional_products', 'required_if_supported_products', 'additional_consented_products',
    'client_name', 'language', 'country_codes', 'user', 'client_user_id', 'webhook', 'redirect_uri',
    'android_package_name', 'account_filters', 'link_customization_name', 'access_token',
    'auth', 'transactions', 'statements', 'identity_verification', 'income_verification',
    'cra_options', 'transfer', 'update', 'hosted_link', 'enable_multi_item_link',
    'link_token', 'expiration', 'hosted_link_url', 'request_id', 'plaid_link_mode',
  ],
  // Documented /auth/get account fields that are conditionally present (only for
  // certain verification methods / regions) and so are absent from the sandbox
  // instant-auth capture — legitimate to show in a demo panel.
  '/auth/get': [
    'verification_status', 'verification_name', 'verification_insights', 'persistent_account_id',
    'holder_category', 'unofficial_currency_code', 'is_tokenized_account_number', 'wire_routing',
  ],
};

/** Normalize an endpoint label ("POST /auth/get", "/auth/get, ...") → "/auth/get". */
function normalizeEndpoint(ep) {
  let s = String(ep || '').trim();
  s = s.replace(/^[A-Z]+\s+/, '');          // strip leading "POST "/"GET "
  s = s.split(/[\s,]/)[0];                   // first token (drop ", ..." labels)
  s = s.replace(/[`'"]/g, '').trim();
  if (s && !s.startsWith('/')) s = '/' + s;
  return s.replace(/\/+$/, '') || s;
}

/** Recursively collect dotted field paths (`a.b[].c`) → JS type, from an object. */
function collectPaths(obj, prefix = '', out = new Map()) {
  if (Array.isArray(obj)) {
    // Represent arrays with a `[]` segment; descend into the first element shape.
    if (obj.length) collectPaths(obj[0], prefix + '[]', out);
    else out.set(prefix + '[]', 'array-empty');
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.set(p, jsType(v));
      collectPaths(v, p, out);
    }
    return out;
  }
  return out;
}

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // object | string | number | boolean
}

/** Leaf key of a dotted path (`a.b[].c` → `c`; `a.b[]` → `b`). */
function leafKey(p) {
  const seg = p.split('.').pop();
  return seg.replace(/\[\]$/, '');
}

/** Walk every string value in the response with its path, for format checks. */
function walkStrings(obj, prefix, cb) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walkStrings(v, `${prefix}[${i}]`, cb));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) walkStrings(v, prefix ? `${prefix}.${k}` : k, cb);
  } else if (typeof obj === 'string') {
    cb(prefix, obj);
  }
}

/** Get value at a logical path that may include `[]` (returns first array elem). */
function getAtPath(obj, path) {
  const segs = path.split('.');
  let cur = obj;
  for (let seg of segs) {
    const isArr = seg.endsWith('[]');
    if (isArr) seg = seg.slice(0, -2);
    if (cur == null) return undefined;
    cur = cur[seg];
    if (isArr) cur = Array.isArray(cur) ? cur[0] : undefined;
  }
  return cur;
}

// ── Tier 3: deterministic per-endpoint + global rules ────────────────────────

/**
 * @param {object} response   the demo apiResponse.response
 * @param {string} endpoint   normalized endpoint
 * @returns {Array<finding>}
 */
function deterministicRules(response, endpoint) {
  const f = [];
  const add = (path, problem, severity, correctedShape) =>
    f.push({ path, problem, severity, correctedShape, source: 'deterministic' });

  // ── Global format checks on string values ──
  walkStrings(response, '', (path, val) => {
    const leaf = leafKey(path.replace(/\[\d+\]/g, '[]'));
    if (leaf === 'request_id' && /\s/.test(val)) {
      add(path, `request_id contains whitespace ("${val}") — real request_ids are a single contiguous alphanumeric token`, SEV.HIGH, 'e.g. "Brz8a3kQ9mWxL2p"');
    }
    if (/\.\.\./.test(val)) {
      // Ellipsized id/token — not a real API value.
      add(path, `value is ellipsized/truncated ("${val}") — real API values are not abbreviated with "..."`, SEV.MED, 'use a full sandbox-style value');
    }
  });

  // ── /auth/get: account number must be the FULL number (Auth's purpose) ──
  if (/\/auth\/get$/.test(endpoint)) {
    const ach = (((response || {}).numbers || {}).ach) || [];
    ach.forEach((row, i) => {
      const acct = row && row.account;
      if (typeof acct === 'string' && /\*/.test(acct)) {
        add(`numbers.ach[${i}].account`, `account number is masked ("${acct}") — /auth/get returns the FULL account number; masking only belongs in accounts[].mask`, SEV.HIGH, 'full numeric string, e.g. "1100000211"');
      }
    });
  }

  // ── /signal/evaluate: shape + range + enum ──
  if (/\/signal\/evaluate$/.test(endpoint)) {
    const rs = (response || {}).ruleset || {};
    if (Array.isArray(rs.triggered_rule_details)) {
      add('ruleset.triggered_rule_details', 'triggered_rule_details is an array — the contract is object | null (an empty/no-trigger result should be null)', SEV.HIGH, 'null, or { internal_note, custom_action_key }');
    }
    if (rs.result != null && !['ACCEPT', 'REVIEW', 'REROUTE'].includes(String(rs.result))) {
      add('ruleset.result', `ruleset.result "${rs.result}" is not a documented value — enum is ACCEPT | REVIEW | REROUTE (REJECT is NOT documented)`, SEV.HIGH, '"ACCEPT" | "REVIEW" | "REROUTE"');
    }
    const scores = (response || {}).scores || {};
    for (const [k, v] of Object.entries(scores)) {
      const sc = v && typeof v === 'object' ? v.score : v;
      if (typeof sc === 'number' && (sc < 1 || sc > 99 || !Number.isInteger(sc))) {
        add(`scores.${k}.score`, `Signal score ${sc} out of range — scores are integers 1–99`, SEV.MED, 'integer 1–99');
      }
    }
  }

  return f;
}

// ── Tier 1 + Tier 2: presence diffs against ground truth ─────────────────────

/**
 * Diff demo field paths against a live-captured real response (full tree).
 * Flags demo paths whose leaf key is absent under the same parent in the real
 * response (fabricated), and type mismatches at shared paths.
 */
function diffAgainstTree(demoResp, refResp, opts = {}) {
  const {
    exemptPrefixes = [], severity = SEV.HIGH, source = 'live-capture',
    refLabel = 'real (live-captured) response', exemptLeafNames = new Set(),
  } = opts;
  const findings = [];
  const isExempt = (p) => exemptPrefixes.some(pre => p === pre || p.startsWith(pre + '.') || p.startsWith(pre + '['));
  const demo = collectPaths(demoResp);
  // refResp may be a single object or an array of objects (union — e.g. live
  // request + response, so request-config panels aren't false-flagged).
  const refObjs = Array.isArray(refResp) ? refResp.filter(Boolean) : [refResp];
  const ref = new Map();
  for (const r of refObjs) for (const [k, v] of collectPaths(r).entries()) if (!ref.has(k)) ref.set(k, v);
  const refKeysByParent = new Map(); // parent path → Set(leaf keys present in ref)
  for (const p of ref.keys()) {
    const idx = p.lastIndexOf('.');
    const parent = idx >= 0 ? p.slice(0, idx) : '';
    if (!refKeysByParent.has(parent)) refKeysByParent.set(parent, new Set());
    refKeysByParent.get(parent).add(leafKey(p));
  }
  for (const [p, demoType] of demo.entries()) {
    if (isExempt(p)) continue; // documented product-variant field absent from this capture
    const idx = p.lastIndexOf('.');
    const parent = idx >= 0 ? p.slice(0, idx) : '';
    // Only judge a leaf when its PARENT exists in the ref (so we don't false-flag
    // whole optional sub-objects the sandbox/sample left empty).
    if (!refKeysByParent.has(parent)) continue;
    const refLeaves = refKeysByParent.get(parent);
    const key = leafKey(p);
    if (exemptLeafNames.has(key.toLowerCase())) continue; // documented-but-uncaptured field
    if (!refLeaves.has(key)) {
      findings.push({
        path: p,
        problem: `field "${key}" is not present in the ${refLabel} under "${parent || '(root)'}" — likely fabricated`,
        severity,
        correctedShape: `remove, or replace with a real field`,
        source,
      });
      continue;
    }
    const refType = ref.get(p);
    // `null` in the reference means "sandbox/sample left it empty" — NOT a type
    // signal. Never drive a type-mismatch off a null ref value (e.g. sandbox
    // /identity/match returns score:null with no PII to match against).
    if (refType && demoType && refType !== demoType
        && refType !== 'null' && demoType !== 'null'
        && refType !== 'array-empty' && demoType !== 'array-empty') {
      findings.push({
        path: p,
        problem: `type mismatch — demo has ${demoType}, ${refLabel} has ${refType}`,
        severity,
        correctedShape: `use ${refType}`,
        source,
      });
    }
  }
  return findings;
}

// Back-compat alias (live-capture is the HIGH-severity authoritative tree).
function diffAgainstLive(demoResp, liveResp, exemptPrefixes = []) {
  return diffAgainstTree(demoResp, liveResp, { exemptPrefixes, severity: SEV.HIGH, source: 'live-capture' });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Audit all apiResponse blocks in a demo script.
 *
 * @param {object} args
 * @param {object} args.demoScript          parsed demo-script.json
 * @param {object} [args.liveResponses]     parsed artifacts/live-api-responses.json ({responses:{stepId:{endpoint,response,live}}})
 * @param {object} [args.contractSamples]   { [normalizedEndpoint]: <parsed AskBill json_sample object> } for endpoints with no live ground truth
 * @returns {{ blocks: Array, summary: object }}
 */
function auditApiPanels({ demoScript, liveResponses, contractSamples } = {}) {
  const steps = (demoScript && Array.isArray(demoScript.steps)) ? demoScript.steps : [];
  const liveByEndpoint = new Map(); // normalized endpoint → [response, request] (live:true only)
  const liveResp = (liveResponses && liveResponses.responses) || {};
  for (const v of Object.values(liveResp)) {
    if (v && v.live && v.response && v.endpoint) {
      // Union of response + request so request-config panels (e.g.
      // /link/token/create showing products/country_codes) aren't false-flagged.
      liveByEndpoint.set(normalizeEndpoint(v.endpoint), [v.response, v.request].filter(Boolean));
    }
  }
  const samples = contractSamples || {};

  const blocks = [];
  for (const step of steps) {
    const ar = step && step.apiResponse;
    if (!ar || !ar.endpoint || !ar.response || typeof ar.response !== 'object') continue;
    const endpoint = normalizeEndpoint(ar.endpoint);
    const findings = [];
    let groundTruth = 'none';

    const exemptLeafNames = new Set((KNOWN_FIELDS[endpoint] || []).map(s => s.toLowerCase()));
    const hasSample = samples[endpoint] && typeof samples[endpoint] === 'object';
    // Tier 1 — live-capture diff (authoritative, HIGH). Ref = live response ∪
    // live request ∪ AskBill sample. Merging the AskBill sample RESCUES real
    // fields the sandbox capture omits (e.g. /auth/get verification_status,
    // present only for certain verification methods) so they aren't false-
    // flagged HIGH — "fabricated" then requires absence from ALL sources.
    if (liveByEndpoint.has(endpoint)) {
      groundTruth = hasSample ? 'live-capture+askbill' : 'live-capture';
      const refs = liveByEndpoint.get(endpoint).slice();
      if (hasSample) refs.push(samples[endpoint]);
      findings.push(...diffAgainstTree(ar.response, refs, {
        exemptPrefixes: LIVE_DIFF_EXEMPT[endpoint] || [], exemptLeafNames, severity: SEV.HIGH, source: 'live-capture',
      }));
    } else if (hasSample) {
      // Tier 2 — AskBill json_sample tree diff (generated, so MED not HIGH).
      groundTruth = 'askbill-sample';
      findings.push(...diffAgainstTree(ar.response, samples[endpoint], {
        exemptPrefixes: LIVE_DIFF_EXEMPT[endpoint] || [], exemptLeafNames, severity: SEV.MED, source: 'askbill-sample',
        refLabel: 'AskBill canonical sample',
      }));
    }

    // Tier 3 — deterministic rules ALWAYS run (format/shape/enum).
    findings.push(...deterministicRules(ar.response, endpoint));

    // Dedup by path+problem.
    const seen = new Set();
    const deduped = findings.filter(fd => {
      const k = fd.path + '|' + fd.problem;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const high = deduped.filter(d => d.severity === SEV.HIGH).length;
    const med = deduped.filter(d => d.severity === SEV.MED).length;
    const verdict = high > 0 ? 'MAJOR' : (med > 0 || deduped.length ? 'MINOR' : 'ACCURATE');
    blocks.push({ stepId: step.id, endpoint, groundTruth, verdict, findings: deduped });
  }

  const summary = {
    blocksAudited: blocks.length,
    high: blocks.reduce((n, b) => n + b.findings.filter(f => f.severity === SEV.HIGH).length, 0),
    med: blocks.reduce((n, b) => n + b.findings.filter(f => f.severity === SEV.MED).length, 0),
    low: blocks.reduce((n, b) => n + b.findings.filter(f => f.severity === SEV.LOW).length, 0),
    major: blocks.filter(b => b.verdict === 'MAJOR').length,
    minor: blocks.filter(b => b.verdict === 'MINOR').length,
    accurate: blocks.filter(b => b.verdict === 'ACCURATE').length,
  };
  return { blocks, summary };
}

module.exports = {
  auditApiPanels,
  normalizeEndpoint,
  collectPaths,
  deterministicRules,
  diffAgainstLive,
  diffAgainstTree,
  SEV,
};
