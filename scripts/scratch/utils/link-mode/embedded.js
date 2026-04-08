'use strict';

function prepareCreateLinkTokenBody(body) {
  const out = { ...(body || {}) };
  out.linkMode = 'embedded';
  const hosted = (out.hosted_link && typeof out.hosted_link === 'object') ? { ...out.hosted_link } : {};
  const completionRedirect = process.env.PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI;
  if (completionRedirect && typeof completionRedirect === 'string' && completionRedirect.trim()) {
    hosted.completion_redirect_uri = hosted.completion_redirect_uri || completionRedirect.trim();
  }
  out.hosted_link = hosted;
  return out;
}

function validateTokenResponse(json) {
  const errs = [];
  if (!json || typeof json !== 'object') errs.push('Token response is not a JSON object.');
  if (!json || typeof json.link_token !== 'string' || !json.link_token.trim()) {
    errs.push('Missing link_token in token response.');
  }
  if (!json || typeof json.hosted_link_url !== 'string' || !json.hosted_link_url.trim()) {
    errs.push('Missing hosted_link_url in embedded token response.');
  }
  return {
    ok: errs.length === 0,
    errors: errs,
    requiredFields: ['link_token', 'hosted_link_url'],
  };
}

function isLaunchObserved(domState) {
  if (!domState || typeof domState !== 'object') return false;
  if (domState.hostedOpened) return true;
  if (Array.isArray(domState.openedUrls)) {
    return domState.openedUrls.some((u) => /plaid\.com/i.test(String(u || '')));
  }
  return false;
}

function launchSignalDescription() {
  return 'embedded launch signal (hosted Plaid URL open attempt)';
}

module.exports = {
  id: 'embedded',
  prepareCreateLinkTokenBody,
  validateTokenResponse,
  isLaunchObserved,
  launchSignalDescription,
};
