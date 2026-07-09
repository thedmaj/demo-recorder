'use strict';

/**
 * CANONICAL Plaid-launch CTA click-target pattern (constraint-balance plan R2).
 *
 * Matches playwright-script click targets that launch Plaid (Link/Layer) —
 * "link-external-account-btn", "connect_bank", "plaid-link-btn", etc. This was
 * previously restated inline in four places in record-local.js (drift risk:
 * editing one copy silently desynced launch detection between the overrun
 * timer, phase inference, and the click fallback).
 *
 * Consumers:
 *  - record-local.js — launch-phase inference for click rows (overrun timer,
 *    phase fallback).
 *  - build-app.js — the stepless click→goToStep repairer must NEVER convert a
 *    row whose target matches this pattern (the launch click opens the real
 *    Plaid modal on camera and is load-bearing).
 *
 * The pattern matches against the row's CSS selector / data-testid string,
 * case-insensitive. Add new CTA idioms HERE only.
 */
const PLAID_LAUNCH_CTA_TARGET_RE =
  /link[-_]external[-_]account|connect[-_]bank|open[-_]link|link[-_]account[-_]btn|btn[-_]link|link[-_]bank|start[-_]link|initiate[-_]link|plaid[-_]link[-_]btn/i;

module.exports = {
  PLAID_LAUNCH_CTA_TARGET_RE,
};
