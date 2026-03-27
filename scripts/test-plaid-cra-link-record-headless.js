#!/usr/bin/env node
'use strict';
/**
 * Headless browser recording of Plaid Link initialized for CRA (Check / Consumer Report).
 *
 * - Sets CRA link token (cra_base_report + cra_income_insights + EXTENSION_OF_CREDIT).
 * - Runs Chromium headless with Playwright video capture.
 * - Uses FAST_TIMING presets (~15s target for the in-iframe flow; tune via env vars).
 *
 * Requires: CRA_CLIENT_ID, CRA_SECRET
 * Optional: PLAID_SANDBOX_USERNAME / PLAID_SANDBOX_PASSWORD (default user_credit_*)
 *
 * Outputs:
 *   out/plaid-cra-link-headless-test/recording.webm
 *   out/plaid-cra-link-headless-test/step-timing.json
 *   out/plaid-cra-link-headless-test/result.json
 *
 * Usage:
 *   node scripts/test-plaid-cra-link-record-headless.js
 *   npm run test:record:cra:headless
 */

process.env.PLAID_LINK_RECORD_TEST_PROFILE = 'cra';
process.env.PLAID_LINK_HEADLESS_RECORDING = 'true';
require('./test-plaid-link-record.js');
