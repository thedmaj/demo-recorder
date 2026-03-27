#!/usr/bin/env node
'use strict';
/**
 * Verifies /link/token/create succeeds for CRA products for a matrix of client_user_ids
 * (one per sandbox persona). Does not open Link — only API smoke.
 *
 * Requires: CRA_CLIENT_ID, CRA_SECRET
 *
 * Usage:
 *   node scripts/scratch/verify-cra-link-token-matrix.js
 *
 * Optional env:
 *   PLAID_SANDBOX_PERSONA_MATRIX=user_credit_profile_good,user_credit_profile_excellent
 */

try {
  require('dotenv').config({ override: true });
} catch (_) {
  /* optional dependency in some worktrees */
}
const path = require('path');
const plaid = require(path.join(__dirname, 'utils/plaid-backend'));

const DEFAULT_PERSONAS = [
  'user_credit_profile_excellent',
  'user_credit_profile_good',
  'user_credit_profile_poor',
  'user_credit_bonus',
  'user_credit_joint_account',
];

async function main() {
  if (!process.env.CRA_CLIENT_ID || !process.env.CRA_SECRET) {
    console.log('[cra-matrix] SKIP: CRA_CLIENT_ID / CRA_SECRET not set — cannot call Plaid sandbox.');
    console.log('[cra-framework] Personas to use when recording: ' + DEFAULT_PERSONAS.join(', '));
    process.exit(0);
  }

  const raw = process.env.PLAID_SANDBOX_PERSONA_MATRIX;
  const personas = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_PERSONAS;

  const failures = [];
  for (const persona of personas) {
    const userId = `matrix-${persona}-${Date.now()}`;
    try {
      const res = await plaid.createLinkToken({
        products: ['cra_base_report', 'cra_income_insights'],
        userId,
        consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT',
        credentialScope: 'cra',
      });
      if (!res.link_token) throw new Error('missing link_token');
      console.log(`[cra-matrix] OK  ${persona} → token ${res.link_token.slice(0, 24)}...`);
    } catch (e) {
      console.error(`[cra-matrix] FAIL ${persona}: ${e.message}`);
      failures.push({ persona, error: e.message });
    }
  }

  if (failures.length) {
    console.error(`[cra-matrix] ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log(`[cra-matrix] All ${personas.length} link_token creates succeeded.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
