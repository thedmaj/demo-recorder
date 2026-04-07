#!/usr/bin/env node
'use strict';
/**
 * Runs test-plaid-link-record.js in Plaid Check / CRA Link mode.
 *
 * Requires CRA_CLIENT_ID and CRA_SECRET. Uses user_credit_* sandbox bank logins
 * (default user_credit_profile_good / pass_good); override with
 * PLAID_SANDBOX_USERNAME / PLAID_SANDBOX_PASSWORD.
 *
 * Outputs: out/plaid-cra-link-test/
 *
 * Usage:
 *   node scripts/test-plaid-cra-link-record.js
 */

require('./test-plaid-link-record.js');
