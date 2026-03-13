/**
 * Plaid Link Asset Library — Core Credentials Flow
 * Compatible with demo-recorder Playwright pipeline
 *
 * Step IDs (in order):
 *   consent → institution-search → credentials → account-select → connected
 *
 * Usage:
 *   window.goToStep('institution-search');
 *   window.getCurrentStep();  // returns e.g. 'step-institution-search'
 */

(function () {
  'use strict';

  // ── Link Events Log ──────────────────────────────────────────
  const _eventLog = [];

  window.addLinkEvent = function (eventName, metadata) {
    const ts = new Date().toISOString().substring(11, 23);
    _eventLog.push({ eventName, metadata, ts });
    _renderEvents();
  };

  function _renderEvents() {
    const body = document.querySelector('#link-events-panel .side-panel-body');
    if (!body) return;
    body.innerHTML = _eventLog.slice().reverse().map(e => `
      <div class="link-event-row">
        <div class="link-event-dot"></div>
        <div>
          <div class="link-event-name">${e.eventName}</div>
          <div class="link-event-meta">${e.ts}${e.metadata ? ' · ' + JSON.stringify(e.metadata).substring(0, 60) : ''}</div>
        </div>
      </div>`).join('');
  }

  // ── API Response Panel ───────────────────────────────────────
  window.updateApiResponse = function (obj) {
    const body = document.querySelector('#api-response-panel .side-panel-body');
    if (!body) return;
    body.innerHTML = `<pre class="api-response-pre">${_syntaxHighlight(JSON.stringify(obj, null, 2))}</pre>`;
  };

  function _syntaxHighlight(json) {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      match => {
        if (/^"/.test(match)) {
          return /:$/.test(match)
            ? `<span class="api-key">${match}</span>`
            : `<span class="api-str">${match}</span>`;
        } else if (/true|false/.test(match)) {
          return `<span class="api-bool">${match}</span>`;
        }
        return `<span class="api-num">${match}</span>`;
      }
    );
  }

  // ── Step Navigation ──────────────────────────────────────────
  window.goToStep = function (id) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const target = document.querySelector(`[data-testid="step-${id}"]`);
    if (!target) { console.warn('[plaid-link] step not found:', id); return; }
    target.classList.add('active');

    // Fire link events for this step
    const events = window._stepLinkEvents && window._stepLinkEvents[id];
    if (events) events.forEach(e => window.addLinkEvent(e.eventName, e.metadata));

    // Update API response panel
    const apiResp = window._stepApiResponses && window._stepApiResponses[id];
    if (apiResp) window.updateApiResponse(apiResp);
  };

  window.getCurrentStep = function () {
    const active = document.querySelector('.step.active');
    return active ? active.dataset.testid : null;
  };

  // ── Per-Step Link Events ──────────────────────────────────────
  window._stepLinkEvents = {
    'consent': [
      { eventName: 'OPEN', metadata: { view_name: 'CONSENT' } }
    ],
    'institution-search': [
      { eventName: 'TRANSITION_VIEW', metadata: { view_name: 'SELECT_INSTITUTION' } },
      { eventName: 'SEARCH_INSTITUTION', metadata: { institution_search_query: '' } }
    ],
    'credentials': [
      { eventName: 'SELECT_INSTITUTION', metadata: { institution_name: 'Gingham Bank', institution_id: 'ins_109508' } },
      { eventName: 'TRANSITION_VIEW', metadata: { view_name: 'CREDENTIAL' } }
    ],
    'account-select': [
      { eventName: 'SUBMIT_CREDENTIALS', metadata: {} },
      { eventName: 'TRANSITION_VIEW', metadata: { view_name: 'SELECT_ACCOUNT' } }
    ],
    'connected': [
      { eventName: 'HANDOFF', metadata: { view_name: 'CONNECTED' } }
    ]
  };

  // ── Per-Step API Responses ────────────────────────────────────
  window._stepApiResponses = {
    'credentials': {
      "institution": {
        "institution_id": "ins_109508",
        "name": "Gingham Bank",
        "products": ["auth", "balance", "identity", "transactions"],
        "country_codes": ["US"],
        "routing_numbers": ["021000021"]
      }
    },
    'account-select': {
      "accounts": [
        { "account_id": "BxBXxLj1m4HMXBm9WZZmCWVbPjX1JBxds8PT", "name": "Personal Checking", "mask": "5521", "type": "depository", "subtype": "checking", "balances": { "current": 10324.00, "available": 9870.50 } },
        { "account_id": "dVzbVMLjrxTWgTa3Xw7pYkL3GASHMvdnKPFD", "name": "High Interest Savings", "mask": "7398", "type": "depository", "subtype": "savings", "balances": { "current": 32904.00, "available": 32904.00 } },
        { "account_id": "Pp1Mqz9jq5sxHe6JQnbMXmBHcPJBxyb6jxGx", "name": "College Savings", "mask": "2313", "type": "depository", "subtype": "savings", "balances": { "current": 237.00, "available": 237.00 } }
      ]
    },
    'connected': {
      "public_token": "public-sandbox-b0e2c4ee-a763-4df5-bfe9-46a46bce993d",
      "metadata": {
        "institution": { "name": "Gingham Bank", "institution_id": "ins_109508" },
        "accounts": [
          { "id": "BxBXxLj1m4HMXBm9WZZmCWVbPjX1JBxds8PT", "name": "Personal Checking", "mask": "5521", "type": "depository", "subtype": "checking" }
        ],
        "link_session_id": "d86aca27-6d2a-4d92-91d3-3c6b60a2e5bd",
        "status": "connected"
      }
    }
  };

  // ── Institution Search Filter ─────────────────────────────────
  window.filterInstitutions = function (query) {
    const q = query.toLowerCase().trim();
    const tiles = document.querySelectorAll('.institution-tile');
    tiles.forEach(tile => {
      const name = tile.querySelector('.institution-name')?.textContent.toLowerCase() || '';
      tile.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
    window.addLinkEvent('SEARCH_INSTITUTION', { institution_search_query: query });
  };

  // ── Account Selection ─────────────────────────────────────────
  window.toggleAccount = function (el) {
    el.closest('.account-list').querySelectorAll('.account-item')
      .forEach(i => i.classList.remove('selected'));
    el.closest('.account-item').classList.add('selected');
  };

  // ── Institution Selection ─────────────────────────────────────
  window.selectInstitution = function (name, id) {
    // Update credentials screen with selected institution name
    const credTitle = document.querySelector('[data-testid="step-credentials"] .link-title');
    const credSubtitle = document.querySelector('[data-testid="step-credentials"] .link-subtitle');
    if (credTitle) credTitle.textContent = `Log into ${name}`;
    if (credSubtitle) credSubtitle.textContent = `Enter your ${name} credentials to connect your account to WonderWallet.`;

    const iconEl = document.querySelector('[data-testid="step-credentials"] .institution-icon-lg');
    if (iconEl) iconEl.style.background = _institutionColor(id);

    window._stepLinkEvents['credentials'] = [
      { eventName: 'SELECT_INSTITUTION', metadata: { institution_name: name, institution_id: id } },
      { eventName: 'TRANSITION_VIEW', metadata: { view_name: 'CREDENTIAL' } }
    ];
    window.goToStep('credentials');
  };

  function _institutionColor(id) {
    const colors = { 'ins_109508': '#2563eb', 'ins_109509': '#d97706', 'ins_109510': '#7c3aed' };
    return colors[id] || '#2563eb';
  }

  // ── Init: activate first step ────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    window.goToStep('consent');
  });

})();
