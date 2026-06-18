'use strict';
/**
 * Unit tests for api-panel-validator.js — run: node scripts/scratch/utils/api-panel-validator.test.js
 * Calibrated against the 2026-06-17 manual API-panel audit (AskBill+Glean).
 * Exits non-zero on any failure.
 */
const assert = require('assert');
const { auditApiPanels } = require('./api-panel-validator');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.error(`  FAIL ${name}\n       ${e.message}`); } }
const block = (id, endpoint, response) => ({ id, apiResponse: { endpoint, response } });
const audit = (steps, opts = {}) => auditApiPanels({ demoScript: { steps }, ...opts });
const blk = (res, id) => res.blocks.find(b => b.stepId === id);
const hi = b => b.findings.filter(f => f.severity === 'HIGH');

// Real-shaped live /auth/get capture (ground truth)
const LIVE_AUTH = {
  responses: { cap: { live: true, endpoint: 'POST /auth/get', response: {
    accounts: [{ account_id: 'BxBX', holder_category: 'business', mask: '0000', name: 'X', official_name: 'Y', type: 'depository', subtype: 'checking', balances: {} }],
    numbers: { ach: [{ account_id: 'BxBX', account: '9900009606', routing: '011401533', wire_routing: '021000021', is_tokenized_account_number: false }] },
    item: { item_id: 'gVM8' }, request_id: 'm8MDnv9okwxFEB8',
  } } },
};

// ── No false positives on an ACCURATE Auth block (Keybank) ──
t('Keybank /auth/get is ACCURATE (zero HIGH) — false-positive guard', () => {
  const r = audit([block('auth', 'POST /auth/get', {
    accounts: [{ account_id: 'BxBX', holder_category: 'business', mask: '0000', name: 'Pixel & Paper Co Business Checking', official_name: 'Business Checking Account', type: 'depository', subtype: 'checking' }],
    numbers: { ach: [{ account_id: 'BxBX', account: '9900009606', routing: '011401533', wire_routing: '021000021' }] },
    item: { item_id: 'gVM8' }, request_id: 'm8MDnv9okwxFEB8',
  })], { liveResponses: LIVE_AUTH });
  assert.strictEqual(blk(r, 'auth').verdict, 'ACCURATE', 'should be ACCURATE');
});

// ── live diff catches a fabricated field under a live parent ──
t('live diff flags a fabricated field (HIGH)', () => {
  const r = audit([block('auth', 'POST /auth/get', {
    accounts: [{ account_id: 'BxBX', mask: '0000', type: 'depository', subtype: 'checking', made_up_field: true }],
    numbers: { ach: [{ account: '9900009606', routing: '011401533' }] }, request_id: 'ok',
  })], { liveResponses: LIVE_AUTH });
  const f = hi(blk(r, 'auth'));
  assert.ok(f.some(x => /made_up_field/.test(x.path)), 'should flag made_up_field as fabricated');
});

// ── Current /auth/get: masked account + spaced request_id + ellipsized id (all deterministic) ──
t('Current /auth/get masked account is MAJOR/HIGH', () => {
  const r = audit([block('auth', 'POST /auth/get', {
    accounts: [{ account_id: 'rz9Q...0211', name: 'Plaid Checking', mask: '0211', subtype: 'checking' }],
    numbers: { ach: [{ account: '****0211', routing: '021000021', account_id: 'rz9Q...0211' }] },
    request_id: 'auth_8841 kd92',
  })]); // no live → deterministic only
  const b = blk(r, 'auth');
  assert.strictEqual(b.verdict, 'MAJOR');
  assert.ok(hi(b).some(f => /masked/.test(f.problem)), 'masked account HIGH');
  assert.ok(hi(b).some(f => /request_id contains whitespace/.test(f.problem)), 'spaced request_id HIGH');
  assert.ok(b.findings.some(f => /ellipsized/.test(f.problem)), 'ellipsized id flagged');
});

// ── Keybank /signal/evaluate: triggered_rule_details [] must be object|null ──
t('Signal triggered_rule_details array is HIGH', () => {
  const r = audit([block('sig', 'POST /signal/evaluate', {
    scores: { customer_initiated_return_risk: { score: 12 }, bank_initiated_return_risk: { score: 10 } },
    ruleset: { ruleset_key: 'default', result: 'ACCEPT', triggered_rule_details: [] },
    request_id: 'mdqfuVxeoza6mhu',
  })]);
  const b = blk(r, 'sig');
  assert.ok(hi(b).some(f => /triggered_rule_details is an array/.test(f.problem)), 'array shape HIGH');
});

// ── Signal enum + range ──
t('Signal bad ruleset.result enum + out-of-range score flagged', () => {
  const r = audit([block('sig', 'POST /signal/evaluate', {
    scores: { customer_initiated_return_risk: { score: 0 } },
    ruleset: { result: 'REJECT', triggered_rule_details: null },
    request_id: 'x',
  })]);
  const b = blk(r, 'sig');
  assert.ok(hi(b).some(f => /not a documented value/.test(f.problem)), 'REJECT enum HIGH');
  assert.ok(b.findings.some(f => /out of range/.test(f.problem)), 'score 0 out of range');
});

// ── Conservatism: EWA cash_advance NOT false-flagged when live lacks it (parent guard) ──
t('EWA cash_advance not false-flagged when live signal lacks EWA fields', () => {
  const liveSignal = { responses: { c: { live: true, endpoint: 'POST /signal/evaluate', response: {
    scores: { customer_initiated_return_risk: { score: 8 }, bank_initiated_return_risk: { score: 10 } },
    ruleset: { result: 'ACCEPT', triggered_rule_details: null }, request_id: 'r',
  } } } };
  const r = audit([block('ewa', 'POST /signal/evaluate', {
    scores: { cash_advance: { score: 27 }, customer_initiated_return_risk: { score: 8 }, bank_initiated_return_risk: { score: 56 } },
    core_attributes: { stable_inflows: true, available_balance: 2200 },
    ruleset: { result: 'ACCEPT', triggered_rule_details: { internal_note: 'x' } }, warnings: [], request_id: 'r',
  })], { liveResponses: liveSignal });
  const b = blk(r, 'ewa');
  assert.ok(!b.findings.some(f => /cash_advance/.test(f.path)), 'cash_advance must NOT be flagged (parent scores.cash_advance absent from live → skip)');
  assert.ok(!b.findings.some(f => /stable_inflows/.test(f.path)), 'core_attributes.* must NOT be flagged (parent absent from live → skip)');
});

// ── AskBill json_sample (tree) flags fabricated CRA create fields (MED) ──
t('AskBill sample flags fabricated CRA create fields', () => {
  const contractSamples = { '/cra/check_report/create': { request_id: 'req_x' } };
  const r = audit([block('cra', '/cra/check_report/create', {
    user_id: 'usr_8Kd2mQ', report_token: 'rpt_9xY...', status: 'generating',
  })], { contractSamples });
  const b = blk(r, 'cra');
  assert.notStrictEqual(b.verdict, 'ACCURATE', 'CRA create should be flagged');
  assert.strictEqual(b.groundTruth, 'askbill-sample');
  assert.ok(b.findings.some(f => /report_token/.test(f.path) && f.severity === 'MED'), 'report_token flagged MED');
  assert.ok(b.findings.some(f => /status/.test(f.path)), 'status flagged');
});

// ── null live value must NOT drive a type-mismatch (sandbox /identity/match) ──
t('null live score does not false-flag a numeric demo score', () => {
  const liveIdentity = { responses: { c: { live: true, endpoint: 'POST /identity/match', response: {
    accounts: [{ account_id: 'a', legal_name: { score: null, is_nickname_match: null, is_first_name_or_last_name_match: null },
      phone_number: { score: null }, email_address: { score: null }, address: { score: null, is_postal_code_match: null } }],
    request_id: 'r',
  } } } };
  const r = audit([block('idm', 'POST /identity/match', {
    accounts: [{ account_id: 'a', legal_name: { score: 95, is_nickname_match: false, is_first_name_or_last_name_match: true },
      phone_number: { score: 100 }, email_address: { score: 100 }, address: { score: 92, is_postal_code_match: true } }],
    request_id: 'r',
  })], { liveResponses: liveIdentity });
  assert.strictEqual(blk(r, 'idm').verdict, 'ACCURATE', 'numeric scores vs null sandbox scores must NOT be flagged');
});

// ── Ynab liabilities ACCURATE (no live, no nameset, clean deterministic) ──
t('Ynab /liabilities/get is ACCURATE', () => {
  const r = audit([block('liab', 'POST /liabilities/get', {
    accounts: [{ account_id: 'a', name: 'Home Mortgage', type: 'loan', balances: { current: 397845.12 } }],
    liabilities: { mortgage: [{ account_id: 'a', interest_rate: { percentage: 5.62, type: 'fixed' }, next_payment_due_date: '2026-07-01' }],
      credit: [{ account_id: 'c', aprs: [{ apr_percentage: 19.24, apr_type: 'purchase_apr' }] }] },
  })]);
  assert.strictEqual(blk(r, 'liab').verdict, 'ACCURATE');
});

// ── /link/token/create request-config panel not false-flagged (union + allowlist) ──
t('/link/token/create request-config panel is ACCURATE', () => {
  const live = { responses: { c: { live: true, endpoint: 'POST /link/token/create',
    request: { products: ['auth'], client_name: 'X' },
    response: { link_token: 'lt', expiration: 'e', request_id: 'r', hosted_link_url: 'u', plaid_link_mode: 'm' } } } };
  const r = audit([block('lt', 'POST /link/token/create', {
    products: ['auth', 'signal'], client_name: 'Citi', country_codes: ['US'], language: 'en',
  })], { liveResponses: live });
  assert.strictEqual(blk(r, 'lt').verdict, 'ACCURATE', 'request-config fields (products/country_codes/language) must not be flagged');
});

// ── AskBill sample rescues a real field the sandbox capture omits (/auth/get verification_status) ──
t('AskBill sample rescues verification_status (no false HIGH)', () => {
  const live = { responses: { c: { live: true, endpoint: 'POST /auth/get', response: {
    accounts: [{ account_id: 'a', mask: '0000', type: 'depository', subtype: 'checking', name: 'X' }],
    numbers: { ach: [{ account: '9900009606', routing: '011401533' }] }, request_id: 'r',
  } } } };
  // AskBill canonical sample includes the conditionally-present field.
  const contractSamples = { '/auth/get': {
    accounts: [{ account_id: 'a', mask: '0000', type: 'depository', subtype: 'checking', name: 'X', verification_status: 'automatically_verified' }],
    numbers: { ach: [{ account: '9900009606', routing: '011401533' }] }, request_id: 'r',
  } };
  const r = audit([block('auth', 'POST /auth/get', {
    accounts: [{ account_id: 'a', mask: '0000', type: 'depository', subtype: 'checking', name: 'X', verification_status: 'automatically_verified' }],
    numbers: { ach: [{ account: '9900009606', routing: '011401533' }] }, request_id: 'r',
  })], { liveResponses: live, contractSamples });
  const b = blk(r, 'auth');
  assert.ok(!b.findings.some(f => /verification_status/.test(f.path)), 'verification_status must be rescued by AskBill sample');
  assert.strictEqual(b.verdict, 'ACCURATE');
});

console.log(`\napi-panel-validator: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
