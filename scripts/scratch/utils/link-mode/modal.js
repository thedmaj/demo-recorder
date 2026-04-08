'use strict';

function prepareCreateLinkTokenBody(body) {
  const out = { ...(body || {}) };
  delete out.hosted_link;
  out.linkMode = 'modal';
  return out;
}

function validateTokenResponse(json) {
  const errs = [];
  if (!json || typeof json !== 'object') errs.push('Token response is not a JSON object.');
  if (!json || typeof json.link_token !== 'string' || !json.link_token.trim()) {
    errs.push('Missing link_token in token response.');
  }
  return {
    ok: errs.length === 0,
    errors: errs,
    requiredFields: ['link_token'],
  };
}

function isLaunchObserved(domState) {
  return !!(domState && (domState.hasPlaidIframe || domState.hasHandler));
}

function launchSignalDescription() {
  return 'modal launch signal (Plaid iframe or handler presence)';
}

module.exports = {
  id: 'modal',
  prepareCreateLinkTokenBody,
  validateTokenResponse,
  isLaunchObserved,
  launchSignalDescription,
};
