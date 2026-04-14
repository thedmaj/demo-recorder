'use strict';

function prepareCreateLinkTokenBody(body) {
  const out = { ...(body || {}) };
  // Plaid /link/token/create does not accept mode helper fields.
  delete out.linkMode;
  delete out.link_mode;
  // Embedded Institution Search does NOT use hosted_link_url redirect flow.
  delete out.hosted_link;
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
  if (!domState || typeof domState !== 'object') return false;
  return !!(
    domState.embeddedWidgetLoaded ||
    domState.embeddedInstanceReady ||
    domState.hasPlaidIframe ||
    domState.hasHandler
  );
}

function launchSignalDescription() {
  return 'embedded launch signal (in-page embedded widget rendered)';
}

module.exports = {
  id: 'embedded',
  prepareCreateLinkTokenBody,
  validateTokenResponse,
  isLaunchObserved,
  launchSignalDescription,
};
