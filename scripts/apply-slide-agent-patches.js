#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const D = 'div';

function replaceStepBlock(html, stepId, innerHtml) {
  const openTag = `<${D} data-testid="step-${stepId}" class="step">`;
  const startIdx = html.indexOf(openTag);
  if (startIdx === -1) throw new Error(`step not found: ${stepId}`);
  let depth = 0;
  const re = new RegExp(`<\\/?${D}\\b[^>]*>`, 'g');
  re.lastIndex = startIdx;
  let endIdx = -1;
  for (;;) {
    const m = re.exec(html);
    if (!m) break;
    if (m[0].startsWith(`</${D}`)) depth--;
    else if (!m[0].endsWith('/>')) depth++;
    if (depth === 0 && m.index > startIdx) {
      endIdx = re.lastIndex;
      break;
    }
  }
  if (endIdx === -1) throw new Error(`could not close step-${stepId}`);
  return html.slice(0, startIdx) + openTag + innerHtml + `</${D}>` + html.slice(endIdx);
}

function patch(runId, fn) {
  const p = path.join(ROOT, 'out/demos', runId, 'scratch-app/index.html');
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
  console.log('[patch]', runId);
}

function el(tag, attrs, inner) {
  const a = attrs ? ' ' + attrs : '';
  return `<${tag}${a}>${inner}</${tag}>`;
}

const zipNetwork = [
  el(D, 'class="slide-root" data-slide-template="T4" data-workhorse-layout="kpi-grid"', [
    el(D, 'class="frame"', [
      '<img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">',
      el(D, 'class="eyebrow-tag"', 'Network Insights · Beta'),
      el(D, 'class="slide-stack" style="gap:32px;padding-bottom:24px;"', [
        el('h2', 'class="h-title"', 'Up to 25% lift over <em>bureau-only data.</em>'),
        el(D, 'style="display:flex;gap:48px;align-items:flex-start;flex-wrap:wrap;"', [
          el(D, 'style="flex:1 1 420px;min-width:0;"', [
            el(D, 'class="mint-moment" style="font-family:var(--font-display);font-size:96px;line-height:1;font-weight:500;color:#42F0CD;"', '25%'),
            el('p', 'class="slide-body-text" style="font-size:26px;line-height:1.35;max-width:520px;margin:16px 0 0;"', 'Lift in predictive performance when LendScore + Network Insights pair with bureau data in near-prime BNPL segments.'),
            el(D, 'style="margin-top:28px;"', el('span', 'style="font-size:24px;display:inline-block;padding:12px 16px;border:1px solid rgba(66,240,205,0.4);border-radius:8px;font-family:var(--font-mono);color:#E8E4D8;"', 'plaid_conn_user_lifetime_personal_lending_flag = false')),
            el('p', 'class="slide-body-text" style="font-size:24px;line-height:1.35;max-width:540px;margin:18px 0 0;color:rgba(255,255,255,0.78);"', 'No prior lending defaults across the Plaid network — a signal Zip cannot see in any bureau file.'),
          ].join('')),
          el(D, 'style="flex:1 1 360px;min-width:0;"', el(D, 'class="sc-card" style="padding:24px;"', [
            el(D, 'style="font-size:24px;color:rgba(255,255,255,0.6);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:14px;font-family:var(--font-mono);"', 'POST /cra/check_report/network_insights/get'),
            el('pre', 'style="background:transparent;border:none;padding:0;font-size:24px;line-height:1.45;margin:0;white-space:pre-wrap;font-family:var(--font-mono);color:#E8E4D8;"', '"network_insights": {\n  "model_status": "BETA",\n  "lifetime_personal_lending_flag": false,\n  "active_fintech_connections": 6\n}'),
          ].join(''))),
        ].join('')),
      ].join('')),
      el(D, 'class="chrome-foot"', '<span>Plaid × Zip · Network Insights</span><span>Beta · Limited Availability</span>'),
    ].join('')),
  ].join('')),
].join('');

const bettermentOpener = el(D, 'class="slide-root holo" data-slide-template="T1" data-workhorse-layout="cover"', el(D, 'class="frame" style="display:flex;flex-direction:column;min-height:100%;"', [
  '<img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="">',
  el(D, 'class="slide-stack" style="flex:1;padding-top:56px;padding-bottom:56px;gap:28px;"', [
    el(D, 'class="eyebrow-tag" style="font-family:var(--font-mono);letter-spacing:0.12em;text-transform:uppercase;color:var(--plaid-teal-600);"', '01 · The problem'),
    el('h2', 'class="h-title" style="font-family:var(--font-display);font-weight:500;max-width:14ch;line-height:1.08;"', 'Bring your brokerage in — <em>without the paper forms.</em>'),
    el('p', 'class="slide-body-text" style="max-width:52ch;font-size:26px;line-height:1.35;color:rgba(2,37,68,0.78);margin:0;"', '25–30% of ACATS transfers fail on account-number errors — triggering support tickets, manual intervention, and lost AUM for wealth platforms.'),
  ].join('')),
  el(D, 'class="chrome-foot" style="margin-top:auto;"', '<span>Plaid × Betterment · Investments Move</span><span>Wealth platform onboarding</span>'),
].join('')));

const bettermentPeer = el(D, 'class="slide-root" data-slide-template="T4" data-workhorse-layout="stat-highlight"', el(D, 'class="frame"', [
  '<img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">',
  el(D, 'class="eyebrow-tag" style="color:var(--plaid-teal-500);"', 'Peer benchmark · Investments Move'),
  el(D, 'class="slide-stack" style="gap:36px;padding-bottom:32px;"', [
    el('h2', 'class="h-title" style="max-width:18ch;"', 'Robinhood cut ACATS failures <em>~90%.</em>'),
    el(D, 'class="sc-grid-4" style="grid-template-columns:1fr 1fr;gap:32px;"', [
      el(D, 'class="sc-card"', [
        el(D, 'class="sc-eyebrow" style="font-size:24px;"', 'ACATS failures'),
        el(D, 'class="mint-moment" style="font-family:var(--font-display);font-size:72px;line-height:1;font-weight:500;color:var(--plaid-teal-500);"', '~90% fewer'),
        el(D, 'style="font-size:26px;line-height:1.35;color:rgba(255,255,255,0.78);margin-top:12px;"', 'After adopting Plaid Investments Move for inbound transfers.'),
      ].join('')),
      el(D, 'class="sc-card"', [
        el(D, 'class="sc-eyebrow" style="font-size:24px;"', 'Successful transfers'),
        el(D, 'style="font-family:var(--font-display);font-size:72px;line-height:1;font-weight:500;color:#E8E4D8;"', '3× more'),
        el(D, 'style="font-size:26px;line-height:1.35;color:rgba(255,255,255,0.78);margin-top:12px;"', 'More completed inbound brokerage moves at scale.'),
      ].join('')),
    ].join('')),
    el('p', 'style="font-family:var(--font-mono);font-size:24px;color:rgba(255,255,255,0.74);letter-spacing:0.04em;margin:0;"', 'Source — Robinhood, after adopting Plaid Investments Move'),
  ].join('')),
  el(D, 'class="chrome-foot"', '<span>Peer benchmark · Investments Move</span><span>Plaid × Betterment</span>'),
].join('')));

const bettermentValue = el(D, 'class="slide-root" data-slide-template="T11" data-workhorse-layout="cta"', el(D, 'class="frame"', [
  '<img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt="">',
  el(D, 'class="eyebrow-tag" style="color:var(--plaid-teal-500);"', 'Value summary · Plaid × Betterment'),
  el(D, 'class="slide-stack" style="gap:32px;padding-bottom:32px;"', [
    el('h2', 'class="h-title"', 'Less paperwork. More AUM. <em>Fewer support tickets.</em>'),
    el(D, 'class="sc-grid-3"', [
      el(D, 'class="sc-card"', [el(D,'class="sc-eyebrow" style="color:rgba(255,255,255,0.6);font-family:var(--font-mono);letter-spacing:0.08em;text-transform:uppercase;font-size:24px;"','Verified data'),el('strong','style="font-size:26px;color:var(--plaid-white);line-height:1.25;"','Sourced from institution APIs'),el('p','style="color:rgba(255,255,255,0.74);font-size:24px;line-height:1.5;margin:0;"','Account numbers, DTC codes, and owners pulled directly — no manual entry, no OCR.')].join('')),
      el(D, 'class="sc-card"', [el(D,'class="sc-eyebrow" style="color:rgba(255,255,255,0.6);font-family:var(--font-mono);font-size:24px;letter-spacing:0.08em;text-transform:uppercase;"','Fast resolution'),el('strong','style="font-size:26px;color:var(--plaid-white);line-height:1.25;"','~14 seconds, end-to-end'),el('p','style="color:rgba(255,255,255,0.74);font-size:24px;line-height:1.5;margin:0;"','70–80% of production traffic resolves inside a single Link session.')].join('')),
      el(D, 'class="sc-card"', [el(D,'class="sc-eyebrow" style="color:var(--plaid-teal-500);font-family:var(--font-mono);font-size:24px;letter-spacing:0.08em;text-transform:uppercase;"','Pay for success'),el('strong','class="mint-moment" style="font-size:26px;color:var(--plaid-white);line-height:1.25;"','Fallbacks aren\'t billed'),el('p','style="color:rgba(255,255,255,0.78);font-size:24px;line-height:1.5;margin:0;"','You only pay when Plaid returns verified ACATS data — never on a miss.')].join('')),
    ].join('')),
    el(D, 'style="margin-top:8px;"', [el(D,'style="color:var(--plaid-teal-500);font-family:var(--font-mono);font-size:24px;letter-spacing:0.08em;text-transform:uppercase;"','Next steps'),el(D,'style="color:var(--plaid-white);font-size:26px;line-height:1.4;margin-top:8px;"','Technical review and POC scoping with your Plaid Account Manager.')].join('')),
  ].join('')),
  el(D, 'class="chrome-foot"', '<span>Plaid Investments Move</span><span>Close · Value summary</span>'),
].join('')));

const tiltValue = el(D, 'class="slide-root holo" data-slide-template="T11" data-workhorse-layout="cta"', el(D, 'class="frame"', [
  '<img class="chrome-logo" src="assets/logos/plaid-horizontal-dark.png" alt="">',
  el(D, 'class="eyebrow-tag" style="color:var(--plaid-blue-700);"', 'Value summary · Plaid × Tilt'),
  el(D, 'class="slide-stack" style="gap:32px;padding-bottom:40px;"', [
    el('h2', 'class="h-title"', 'Separate fraud from credit. Grow <em>without growing losses.</em>'),
    el(D, 'class="sc-grid-3"', [
      el(D, 'class="sc-card" style="background:rgba(255,255,255,0.7);border-color:rgba(2,37,68,0.1);"', [el(D,'class="sc-eyebrow" style="color:var(--plaid-blue-600);font-size:24px;"','Trust Index'),el('strong','style="font-size:26px;color:var(--plaid-ink-900);"','Score fraud risk 1–100'),el('p','style="color:rgba(2,37,68,0.7);font-size:24px;line-height:1.5;margin:0;"','Stop synthetic and stolen identities before funding — separate from credit-risk decline.')].join('')),
      el(D, 'class="sc-card" style="background:rgba(255,255,255,0.7);border-color:rgba(2,37,68,0.1);"', [el(D,'class="sc-eyebrow" style="color:var(--plaid-blue-600);font-size:24px;"','Signal'),el('strong','style="font-size:26px;color:var(--plaid-ink-900);"','Score return risk per transaction'),el('p','style="color:rgba(2,37,68,0.7);font-size:24px;line-height:1.5;margin:0;"','Per-advance NSF and return-likelihood scoring at the moment money moves.')].join('')),
      el(D, 'class="sc-card" style="background:rgba(255,255,255,0.7);border-color:rgba(2,37,68,0.1);"', [el(D,'class="sc-eyebrow" style="color:var(--plaid-blue-600);font-size:24px;"','Core attributes'),el('strong','style="font-size:26px;color:var(--plaid-ink-900);"','Explainable decisions'),el('p','style="color:rgba(2,37,68,0.78);font-size:24px;line-height:1.5;margin:0;"','Attributes and rulesets give compliance and risk teams audit-ready rationale.')].join('')),
    ].join('')),
    el(D, 'style="margin-top:12px;display:flex;flex-direction:column;gap:16px;"', [
      el('p', 'style="font-size:26px;color:var(--plaid-ink-900);margin:0;font-family:var(--font-display);font-style:italic;"', 'Next step: greenlight the Protect Retro with Tilt Legal.'),
      el(D, 'style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;"', [
        el('span', 'class="mint-moment" style="font-size:24px;font-weight:600;color:var(--plaid-ink-900);padding:14px 28px;background:var(--plaid-teal-500);border-radius:999px;"', 'Start your Retro →'),
        el('span', 'style="font-size:24px;color:var(--plaid-teal-600);padding:10px 18px;border:1px solid rgba(5,86,92,0.4);border-radius:999px;letter-spacing:0.04em;text-transform:uppercase;font-weight:600;"', 'Trust Index · Limited Availability'),
      ].join('')),
    ].join('')),
  ].join('')),
  el(D, 'class="chrome-foot"', '<span>Value summary · Plaid Protect</span><span>Plaid × Tilt</span>'),
].join('')));

function removeOverlapAutofix(html) {
  return html.replace(/<style data-pipeline-overlap-autofix="v1">[\s\S]*?<\/style>\n?/, '');
}

patch('2026-05-21-Zip-Bnpl-At-Retail-CRA-Auth-Signal-v1', (html) =>
  replaceStepBlock(html, 'network-insights-slide', zipNetwork));

patch('2026-05-25-Betterment-Robo-advisor-Wealth-Platform-Auth-Assets-Transfer-v3', (html) => {
  html = removeOverlapAutofix(html);
  html = replaceStepBlock(html, 'problem-opener-slide', bettermentOpener);
  html = replaceStepBlock(html, 'peer-benchmark-slide', bettermentPeer);
  return replaceStepBlock(html, 'value-summary-slide', bettermentValue);
});

patch('2026-05-22-Tilt-Cash-Advance-Funnel-Auth-Identity-Signal-Income-Protect-v1', (html) =>
  replaceStepBlock(html, 'value-summary-slide', tiltValue));

console.log('[patch] done');
