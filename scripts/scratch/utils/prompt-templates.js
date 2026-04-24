/**
 * prompt-templates.js
 *
 * All Claude prompt assembly functions for the Plaid demo pipeline.
 * Pure data transformation — no business logic, no I/O, no API calls.
 * Each function returns a { system, userMessages } object ready to pass
 * directly to the Anthropic SDK messages.create() call.
 *
 * Exports:
 *   buildResearchPrompt(config)
 *   buildScriptGenerationPrompt(ingestedInputs, productResearch)
 *   buildAppArchitectureBriefPrompt(demoScript)
 *   buildAppFrameworkPlanPrompt(demoScript, architectureBrief, opts?)
 *   buildAppGenerationPrompt(demoScript, architectureBrief, qaReport?, opts?)
 *   buildQAReviewPrompt(step, framesBase64, expectedState)
 *   buildSegmentationPrompt(videoAnalysis, productResearch)
 *   buildNarrationPolishPrompt(steps, productResearch)
 *   buildOverlayPlanPrompt(demoScript, videoAnalysis)
 *   buildScriptCritiquePrompt(demoScript, productResearch)
 */

'use strict';

const { getProductProfile, inferProductFamilyFromText } = require('./product-profiles');
const { buildCuratedProductKnowledge, buildCuratedDigest } = require('./product-knowledge');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise a value to a formatted JSON string, or return a safe fallback.
 * @param {*} value
 * @returns {string}
 */
function toJSON(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

/** JS source snippet: JSON.stringify({...}) for prompts / LIVE PLAID examples. */
function formatLinkTokenCreateFetchBodySnippet(linkTokenCreate) {
  const base = linkTokenCreate?.suggestedClientRequest || { client_name: '<BrandName>' };
  try {
    return 'JSON.stringify(' + JSON.stringify(base) + ')';
  } catch (_) {
    return `JSON.stringify({ client_name: '<BrandName>' })`;
  }
}

/** Normalize synthesizedInsights for prompts (string or structured object from research). */
function formatSynthesizedInsights(si) {
  if (si == null || si === '') return '';
  if (typeof si === 'string') return si;
  try {
    return JSON.stringify(si, null, 2);
  } catch (_) {
    return String(si);
  }
}

function resolveProductFamily(productResearch = {}, promptText = '') {
  if (productResearch.productFamily) return productResearch.productFamily;
  return inferProductFamilyFromText(promptText || productResearch.product || '');
}

function formatProductAccuracyRules(profile) {
  const rules = (profile?.accuracyRules || []).map(rule => `- ${rule}`).join('\n');
  return rules || '- Verify all product-specific claims against the supplied research.';
}

function formatProductCritiqueRules(profile) {
  const rules = (profile?.critiqueRules || []).map(rule => `- ${rule}`).join('\n');
  return rules || '- Verify terminology and flow accuracy against the supplied product research.';
}

function formatCuratedKnowledge(curatedKnowledge, opts = {}) {
  if (!curatedKnowledge || typeof curatedKnowledge !== 'object') return '';
  const omitDifferentiators = !!opts.omitMarketingDifferentiators;
  const sections = [];

  if (Array.isArray(curatedKnowledge.knowledgeFiles) && curatedKnowledge.knowledgeFiles.length > 0) {
    const blocks = curatedKnowledge.knowledgeFiles.map(file => {
      const parts = [];
      if (file.source) parts.push(`Source: ${file.source}`);
      if (file.overview) parts.push(`Overview:\n${file.overview}`);
      if (file.whereItFits) parts.push(`Where It Fits:\n${file.whereItFits}`);
      if (file.narrationTalkTracks) parts.push(`Narration Talk Tracks:\n${file.narrationTalkTracks}`);
      if (file.accurateTerminology) parts.push(`Accurate Terminology:\n${file.accurateTerminology}`);
      if (!omitDifferentiators && file.differentiators) parts.push(`Differentiators:\n${file.differentiators}`);
      if (file.aiResearchNotes) parts.push(`AI Research Notes:\n${file.aiResearchNotes}`);
      return parts.join('\n\n');
    }).filter(Boolean);
    if (blocks.length > 0) {
      sections.push(`## CURATED PRODUCT KNOWLEDGE\n\n${blocks.join('\n\n---\n\n')}`);
    }
  }

  if (curatedKnowledge.qaFixLogExcerpt) {
    sections.push(`## FRAMEWORK QA LEARNINGS\n\n${curatedKnowledge.qaFixLogExcerpt}`);
  }

  return sections.join('\n\n');
}

/**
 * Prefer budgeted digest; fall back to building digest from full curated knowledge.
 */
function resolveCuratedKnowledgeForPrompt(productResearch, productFamily) {
  let digest = productResearch && productResearch.curatedDigest;
  if (!digest || !Array.isArray(digest.knowledgeFiles)) {
    const base = (productResearch && productResearch.curatedProductKnowledge)
      || buildCuratedProductKnowledge(productFamily);
    digest = buildCuratedDigest(base);
  }
  return digest;
}

function formatPipelineRunContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [];
  if (ctx.productFamily) lines.push(`- Resolved product family: ${ctx.productFamily}`);
  if (ctx.productProfile && ctx.productProfile.label) {
    lines.push(`- Product profile: ${ctx.productProfile.label}`);
  }
  if (ctx.demoScriptSummary) {
    const s = ctx.demoScriptSummary;
    lines.push(`- Demo script: ${s.product || 'n/a'} — ${s.stepCount || 0} step(s)`);
  }
  if (ctx.approvedClaimsDigest && Array.isArray(ctx.approvedClaimsDigest.fromResearch)) {
    const ar = ctx.approvedClaimsDigest.fromResearch.slice(0, 10);
    if (ar.length) lines.push(`- Approved research claims (sample): ${ar.join(' | ')}`);
  }
  if (ctx.linkTokenCreate && Array.isArray(ctx.linkTokenCreate.products) && ctx.linkTokenCreate.products.length) {
    const src = ctx.linkTokenCreate.askBillOnlyInvestmentsMoveAuthGet
      ? 'AskBill-only (Investments Move + POST /investments/auth/get)'
      : 'prompt + AskBill';
    lines.push(`- Link token products (${src}): ${ctx.linkTokenCreate.products.join(', ')}`);
  }
  if (ctx.linkTokenCreate && ctx.linkTokenCreate.suggestedClientRequest) {
    lines.push(
      `- Suggested POST /api/create-link-token JSON (merge brand): ${JSON.stringify(ctx.linkTokenCreate.suggestedClientRequest)}`
    );
  }
  if (!lines.length) return '';
  return `## PIPELINE RUN CONTEXT (canonical snapshot — use for consistency)\n\n${lines.join('\n')}`;
}

function formatBuildQaDiagnosticSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.categoryCounts;
  if (!counts || typeof counts !== 'object' || Object.keys(counts).length === 0) return '';
  let out = `## BUILD-QA DIAGNOSTIC SUMMARY\n\nCategory counts from the Playwright build walkthrough:\n${toJSON(counts)}\n`;
  if (Array.isArray(summary.criticalStepIds) && summary.criticalStepIds.length) {
    out += `Steps with critical diagnostics: ${summary.criticalStepIds.join(', ')}\n`;
  }
  return out;
}

function formatSolutionsMasterPromptBlock(solutionsMaster, opts = {}) {
  if (!solutionsMaster || typeof solutionsMaster !== 'object') return '';
  const omitVp = !!opts.omitValuePropositionStatements;
  const requested = Array.isArray(solutionsMaster.requestedSolutionNames)
    ? solutionsMaster.requestedSolutionNames
    : [];
  const resolved = Array.isArray(solutionsMaster.resolvedSolutions)
    ? solutionsMaster.resolvedSolutions
    : [];
  const unresolved = Array.isArray(solutionsMaster.unresolvedSolutionNames)
    ? solutionsMaster.unresolvedSolutionNames
    : [];
  const vps = Array.isArray(solutionsMaster.valuePropositionStatements)
    ? solutionsMaster.valuePropositionStatements.slice(0, 20)
    : [];
  const apis = Array.isArray(solutionsMaster.apiNames)
    ? solutionsMaster.apiNames.slice(0, 30)
    : [];
  const hasCore =
    requested.length > 0 ||
    resolved.length > 0 ||
    unresolved.length > 0 ||
    apis.length > 0 ||
    (!omitVp && vps.length > 0);
  if (!hasCore && !(omitVp && vps.length > 0)) return '';
  const lines = [];
  if (requested.length) lines.push(`- Requested solutions: ${requested.join(' | ')}`);
  if (resolved.length) lines.push(`- Resolved solutions: ${resolved.map((s) => s.name || s.id).join(' | ')}`);
  if (unresolved.length) lines.push(`- Unresolved solutions: ${unresolved.join(' | ')}`);
  if (apis.length) lines.push(`- APIs/components referenced: ${apis.join(' | ')}`);
  if (!omitVp && vps.length) {
    lines.push('- Value proposition statements from solution plays/content:');
    vps.forEach((v) => lines.push(`  - ${v}`));
  } else if (omitVp && vps.length) {
    lines.push(
      '- Value proposition statements: **omitted from this build prompt** — they remain in `product-research.json` / pipeline artifacts and in the dashboard **storyboard** (step narration). Do **not** paste them into visible host demo HTML (banners, hero lines, stat callouts, tooltips, or marketing cards).'
    );
  }
  if (solutionsMaster.transportUsed) lines.push(`- Transport used: ${solutionsMaster.transportUsed}`);
  return `## SOLUTIONS MASTER CONTEXT\n\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand theming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inline Plaid brand defaults — used when no brand profile is loaded.
 * Matches brand/plaid.json exactly. Keeps the module self-contained.
 */
const PLAID_DEFAULT_BRAND = {
  name: 'Plaid', slug: 'plaid', mode: 'dark',
  colors: {
    bgPrimary: '#0d1117', bgGradient: 'linear-gradient(135deg, #0d1117, #0a2540)',
    accentCta: '#00A67E', textPrimary: '#ffffff',
    textSecondary: 'rgba(255,255,255,0.65)', textTertiary: 'rgba(255,255,255,0.35)',
    accentBorder: 'rgba(0,166,126,0.45)', accentBgTint: 'rgba(0,166,126,0.12)',
    error: '#f87171', success: '#22c55e',
  },
  typography: {
    fontHeading: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    fontBody:    'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
    fontMono:    '"SF Mono", "Fira Code", Consolas, monospace',
    scaleH1: '32px/700', scaleH2: '24px/600', scaleH3: '18px/600', scaleBody: '15px/400',
    headingLetterSpacing: '-0.02em', headingLineHeight: '1.2', bodyLineHeight: '1.6',
  },
  motion: {
    stepTransition: 'opacity 0.3s ease, transform 0.3s ease',
    cardEntrance: 'fadeIn + translateY(10px → 0) 0.4s ease-out',
    buttonHover: 'all 0.2s ease', modalScale: 'scale(0.95 → 1.0) 0.25s ease',
    loadingIndicatorColor: '#00A67E',
  },
  atmosphere: {
    overlayBackdropFilter: 'blur(8px)', cardBorderRadius: '8px',
    cardBoxShadow: '0 2px 8px rgba(0,0,0,0.15)', cardPadding: '32px',
    maxContentWidth: '1440px',
  },
  sidePanels: {
    bg: '#0d1117', accentColor: '#00A67E',
    jsonKeyColor: '#7dd3fc', jsonStringColor: '#ffffff', jsonNumberColor: '#86efac',
  },
  logo: { wordmark: 'PLAID', letterSpacing: '0.1em', fontWeight: '700', fontSize: '16px', color: '#00A67E' },
  promptInstructions: 'Host app chrome uses dark navy palette. Plaid Link modal is always white, controlled by the assetlib design plugin.',
};

/**
 * Renders a brand profile object into the design system block injected into the
 * app-generation system prompt. Covers the HOST APP chrome only — the Plaid Link
 * modal is always white/Plaid-branded, controlled separately by the assetlib plugin.
 *
 * @param {object} brand  Parsed brand profile (brand/*.json or PLAID_DEFAULT_BRAND)
 * @returns {string}
 */
function renderBrandBlock(brand) {
  const c  = brand.colors      || {};
  const t  = brand.typography  || {};
  const m  = brand.motion      || {};
  const a  = brand.atmosphere  || {};
  const sp = brand.sidePanels  || {};
  const logo = brand.logo      || {};
  const logoShellBg = logo.shellBg || 'transparent';
  const logoShellBorder = logo.shellBorder || 'transparent';
  const logoCandidates = Array.from(
    new Set(
      [logo.imageUrl, logo.darkImageUrl, logo.iconUrl]
        .map((u) => String(u || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
    )
  );

  const lines = [];
  lines.push(`- HOST APP DESIGN SYSTEM — ${brand.name} brand (applies to app chrome only; Plaid Link modal is always white/Plaid-branded):`);

  // Colors
  lines.push(`    Mode:              ${brand.mode || 'dark'}`);
  if (c.bgGradient) {
    lines.push(`    Background:        ${c.bgPrimary} or ${c.bgGradient}`);
  } else {
    lines.push(`    Background:        ${c.bgPrimary}`);
  }
  lines.push(`    Primary CTA color: ${c.accentCta}`);
  lines.push(`    Text primary:      ${c.textPrimary}`);
  lines.push(`    Text secondary:    ${c.textSecondary}`);
  lines.push(`    Text tertiary:     ${c.textTertiary}`);
  lines.push(`    Accent border:     ${c.accentBorder}`);
  lines.push(`    Accent bg tint:    ${c.accentBgTint}`);
  lines.push(`    Error color:       ${c.error}`);
  lines.push(`    Success color:     ${c.success}`);
  if (c.surfaceCard)      lines.push(`    Card surface:      ${c.surfaceCard}`);
  if (c.navBg)            lines.push(`    Nav background:    ${c.navBg}`);
  if (c.navAccentStripe)  lines.push(`    Nav accent stripe: ${c.navAccentStripe}`);
  if (c.footerBg)         lines.push(`    Footer background: ${c.footerBg}`);

  // Host banner contrast guardrail. Computed by `brand-contrast.js` during
  // brand-extract so downstream prompts have a single authoritative signal
  // for "where may I place the logo?".
  const hb = brand.hostBanner || null;
  if (hb && hb.bg) {
    lines.push('');
    lines.push(`    HOST BANNER / NAV BACKGROUND — authoritative:`);
    lines.push(`      bg:              ${hb.bg}`);
    lines.push(`      logo tone:       ${hb.logoTone || 'unknown'}  (source: ${hb.toneSource || 'n/a'})`);
    if (hb.accentStripe) lines.push(`      accent stripe:   ${hb.accentStripe}`);
    if (hb.contrastRatio != null) lines.push(`      contrast ratio:  ${hb.contrastRatio}:1 (WCAG — 4.5+ required for text)`);
    lines.push(`      reason:          ${hb.reason || 'no reason supplied'}`);
    lines.push(`      RULE: the host top-nav / banner MUST use bg=${hb.bg}. Do NOT place the logo image or text wordmark on a background of similar luminance.`);
    if (hb.fallback) {
      lines.push(`      FALLBACK MODE: brand tokens could not guarantee logo visibility on the brand's preferred nav color. Use a WHITE banner with the accent stripe (${hb.accentStripe || 'brand accent'}) as a bottom border or left-side stripe.`);
    }
  }

  // Typography
  lines.push(`    Font (heading):    ${t.fontHeading}`);
  lines.push(`    Font (body):       ${t.fontBody}`);
  lines.push(`    Font (mono):       ${t.fontMono}`);
  if (t.googleFontsImport) {
    lines.push(`    Google Fonts:      Add in <style> inside <head> (CSS @import, NOT a script tag):`);
    lines.push(`                       ${t.googleFontsImport}`);
  }
  lines.push(`    Type scale:        H1 ${t.scaleH1}, H2 ${t.scaleH2}, H3 ${t.scaleH3}, Body ${t.scaleBody}`);
  lines.push(`    Letter-spacing:    headings ${t.headingLetterSpacing}`);
  lines.push(`    Line-height:       headings ${t.headingLineHeight}, body ${t.bodyLineHeight}`);

  // Motion and atmosphere
  lines.push(`    Step transition:   ${m.stepTransition}`);
  lines.push(`    Card entrance:     ${m.cardEntrance}`);
  lines.push(`    Button hover:      ${m.buttonHover}`);
  lines.push(`    Modal scale-in:    ${m.modalScale}`);
  if (m.loadingIndicatorColor) lines.push(`    Loading indicator: ${m.loadingIndicatorColor}`);
  lines.push(`    Overlay panels:    backdrop-filter: ${a.overlayBackdropFilter}`);
  lines.push(`    Card border-radius:${a.cardBorderRadius}`);
  lines.push(`    Card box-shadow:   ${a.cardBoxShadow}`);
  lines.push(`    Max content width: ${a.maxContentWidth}`);
  if (a.sidebarWidth) lines.push(`    Sidebar width:     ${a.sidebarWidth}`);

  // Side panels
  if (sp.bg)              lines.push(`    Side-panel bg:     ${sp.bg}`);
  if (sp.accentColor)     lines.push(`    Side-panel accent: ${sp.accentColor}`);
  if (sp.jsonKeyColor)    lines.push(`    JSON key color:    ${sp.jsonKeyColor}`);
  if (sp.jsonStringColor) lines.push(`    JSON string color: ${sp.jsonStringColor}`);
  if (sp.jsonNumberColor) lines.push(`    JSON number color: ${sp.jsonNumberColor}`);

  // Logo: ONE Brandfetch mark in nav — wordmark + square icon are often the same tile (double TD).
  if (logoCandidates.length > 0) {
    const primaryLogo = logoCandidates[0];
    const fallbackLogos = logoCandidates.slice(1);
    const fallbackCode = fallbackLogos.length > 0
      ? ` this.dataset.fallbackIdx='0'; this.onerror=function(){var f=[${fallbackLogos.map((u) => `'${u.replace(/'/g, "\\'")}'`).join(',')}]; var i=Number(this.dataset.fallbackIdx||0); if(i<f.length){this.src=f[i]; this.dataset.fallbackIdx=String(i+1);} else {this.onerror=null;}};`
      : '';
    lines.push(
      `    Logo image (HOST): insert exactly one logo image dynamically with fallback URLs:\n` +
      `      <div data-testid="host-bank-logo-shell" style="display:inline-flex;align-items:center;justify-content:center;padding:6px 10px;border-radius:10px;background:${logoShellBg};border:1px solid ${logoShellBorder}">\n` +
      `        <img src="${primaryLogo}" alt="${(brand.name || 'Bank').replace(/"/g, '')}" data-testid="host-bank-logo-img" height="28" style="object-fit:contain;max-height:32px;" onerror="${fallbackCode.trim()}">\n` +
      `      </div>\n` +
      `      exactly ONE bank mark in the header/nav per step. Do NOT add a second Brandfetch <img> beside it.`
    );
  }
  if (logo.wordmark) {
    const svgVal = logo.svgOrEmoji && !logo.svgOrEmoji.match(/\p{Emoji}/u) ? `${logo.svgOrEmoji} ` : '';
    lines.push(`    Logo (text fallback): ${svgVal}"${logo.wordmark}" — color ${logo.color || c.accentCta}, ` +
      `${logo.fontSize}/${logo.fontWeight}, letter-spacing ${logo.letterSpacing || 'normal'}` +
      (logo.imageUrl ? ` (use only if images fail to load)` : ''));
  }

  // Frontend-design quality principles — scoped to host app chrome only
  lines.push(`    FRONTEND DESIGN PRINCIPLES (host app chrome only):`);
  lines.push(`      - Make the app unmistakably feel like ${brand.name}'s product — not a generic SaaS template.`);
  lines.push(`        Use real brand patterns. Depth and surface hierarchy: ${brand.mode === 'light'
    ? 'white cards on light-gray page bg, subtle shadows, clear nav separation'
    : 'layered dark surfaces, accent color glows, high contrast CTAs'}.`);
  lines.push(`      - UX baseline for host apps: default the PRIMARY page background to white or a very light neutral`);
  lines.push(`        whenever brand colors allow. Keep contrast strong and preserve brand accents on CTA, nav, and key highlights.`);
  lines.push(`        Reserve dark, Plaid-heavy surfaces for explicit Plaid insight/slide contexts, not general host screens.`);
  lines.push(`      - For dark-brand profiles, reinterpret tokens for host UX: keep nav/sidebar brand-forward if needed,`);
  lines.push(`        but keep the content canvas and primary cards on light surfaces by default (white/light-gray).`);
  if (c.navAccentStripe) {
    lines.push(`      - Prefer ${c.navAccentStripe} for host emphasis accents when a brighter CTA token feels too aggressive on light surfaces.`);
  }
  lines.push(`      - Motion with purpose: step transitions use "${m.stepTransition}".`);
  lines.push(`        Card entrances: ${m.cardEntrance}. Button hover: ${m.buttonHover}.`);
  lines.push(`      - Typography as identity: headings set in ${(t.fontHeading || '').split(',')[0]}.`);
  lines.push(`        Never substitute with a generic sans-serif unless it's the explicit first fallback.`);
  lines.push(`      - DO NOT apply these principles to the Plaid Link modal — it is always white (#ffffff), Plaid-branded, 400×720px.`);

  // Conflict-prevention when overriding Plaid defaults
  if (brand.slug && brand.slug !== 'plaid') {
    lines.push(`    IMPORTANT: This is a ${brand.name} host application. Do NOT use Plaid's dark navy (#0d1117),`);
    lines.push(`    Plaid teal (#00A67E), or Plaid gradient backgrounds in the host app chrome.`);
    lines.push(`    The visualState descriptions in the demo script are authoritative for step-level layout.`);
    lines.push(`    Where this design system and visualState conflict: visualState wins for per-step layout;`);
    lines.push(`    this design system wins for global tokens (colors, fonts, nav, sidebar patterns).`);
  }

  // Brand-specific layout rules from promptInstructions
  if (brand.promptInstructions && brand.promptInstructions.trim()) {
    lines.push(`    BRAND-SPECIFIC LAYOUT RULES:`);
    brand.promptInstructions
      .split(/\.\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(s => lines.push(`      - ${s}.`));
  }

  return lines.join('\n');
}

function shouldInjectLayerMobileMockTemplate(demoScript, mobileVisualEnabled) {
  if (!mobileVisualEnabled || !demoScript || !Array.isArray(demoScript.steps)) return false;
  const product = String(demoScript.product || '').toLowerCase();
  if (product.includes('layer')) return true;
  return demoScript.steps.some((step) => {
    const hay = [
      step?.id,
      step?.label,
      step?.visualState,
      step?.narration,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes('layer') && (hay.includes('phone') || hay.includes('mobile'));
  });
}

function shouldIncludeLiveLinkInstructionBlock({ demoScript, promptText, useLayerMobileMockTemplate }) {
  if (!useLayerMobileMockTemplate) return true;
  const scriptText = [
    demoScript?.title,
    demoScript?.product,
    ...(Array.isArray(demoScript?.steps)
      ? demoScript.steps.map((step) => [step?.id, step?.label, step?.narration, step?.visualState].filter(Boolean).join(' '))
      : []),
  ].filter(Boolean).join(' ').toLowerCase();
  const prompt = String(promptText || '').toLowerCase();
  const haystack = `${prompt}\n${scriptText}`;

  const wantsBoth =
    /\b(use both|both layer and plaid link|layer and plaid link)\b/.test(haystack) ||
    /\b(ineligible|not eligible|fallback)\b[\s\S]{0,120}\bplaid link\b/.test(haystack) ||
    /\bplaid link\b[\s\S]{0,120}\b(ineligible|not eligible|fallback)\b/.test(haystack);
  return wantsBoth;
}

function inferLayerDataSharingUseCase(demoScript) {
  if (!demoScript || !Array.isArray(demoScript.steps)) return 'account_verification';
  const chunks = [];
  chunks.push(String(demoScript.product || ''));
  for (const step of demoScript.steps) {
    chunks.push(String(step?.id || ''));
    chunks.push(String(step?.label || ''));
    chunks.push(String(step?.visualState || ''));
    chunks.push(String(step?.narration || ''));
    if (step?.apiResponse?.endpoint) chunks.push(String(step.apiResponse.endpoint));
    if (step?.apiResponse?.method) chunks.push(String(step.apiResponse.method));
    if (step?.apiResponse?.request) chunks.push(JSON.stringify(step.apiResponse.request));
    if (step?.apiResponse?.response) chunks.push(JSON.stringify(step.apiResponse.response));
  }
  const hay = chunks.join(' ').toLowerCase();
  const isCra = /\bcra\b|consumer report|check report|income insights|cra_base_report|\/cra\/|\/user\/create|permissible purpose|extension_of_credit/.test(hay);
  if (isCra) return 'cra';
  const isIdentity =
    /\bidentity verification\b|\bidv\b|\bkyc\b|ssn|date[_\s-]?of[_\s-]?birth|dob|identity_verification|\/identity_verification\//.test(hay);
  if (isIdentity) return 'identity_verification';
  return 'account_verification';
}

function buildLayerShareFieldGuardrailBlock(demoScript) {
  const useCase = inferLayerDataSharingUseCase(demoScript);
  const byUseCase = {
    account_verification:
      `Use case resolved: ACCOUNT_VERIFICATION / PAY-BY-BANK / ACCOUNT LINKING.\n` +
      `Required default share fields: name, phone, address, email (if available), bank account context.\n` +
      `Forbidden by default: date_of_birth, ssn, ssn_last_4.\n` +
      `Only include DOB/SSN fields when the script explicitly states compliance/KYC requirements.`,
    identity_verification:
      `Use case resolved: IDENTITY_VERIFICATION.\n` +
      `Required share fields: name, address, phone, date_of_birth, ssn (or ssn_last_4), and email when used.\n` +
      `DOB/SSN context MUST be visible on the Layer confirmation/share screen.\n` +
      `Do not downgrade to account-link-only fields for this flow.`,
    cra:
      `Use case resolved: CRA / CONSUMER REPORT.\n` +
      `Required identity share fields: name, address, date_of_birth, ssn (or ssn_last_4), phone, email (per account config).\n` +
      `Bank account rows are optional and should appear only when the story/template requires account-derived data.\n` +
      `Treat this as strict identity consent context, not a lightweight account-link flow.`,
  };
  return (
    `## LAYER SHARE FIELD GUARDRAIL (NON-NEGOTIABLE)\n\n` +
    `${byUseCase[useCase]}\n\n` +
    `Generation checks (must pass):\n` +
    `- Screen 1 phone capture copy must frame onboarding/signup/application start, not an eligibility check.\n` +
    `- Never show user-facing phrases like "eligibility check" or "checking eligibility" on screen 1.\n` +
    `- Add subtle helper text below the mobile frame for Layer experiences with exact routing guidance:\n` +
    `  "Use 415-555-1111 for instant Layer eligibility. Use 415-555-0011 to see ineligible fallback (PII + Plaid Link)."\n` +
    `- Phone input should prefill the eligible number first: 415-555-1111.\n` +
    `- Field list on mock Layer share screen must match resolved use case above.\n` +
    `- If this contract conflicts with generic UI habits, this contract wins.\n` +
    `- Do not use one universal field list across all Layer stories.\n`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Research prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that drives product research using AskBill and Glean tools.
 *
 * @param {{
 *   product: string,
 *   productShortName: string,
 *   persona: string,
 *   targetAudience: string,
 *   researchTopics: string[]
 * }} config
 * @returns {{ system: string, userMessages: Array }}
 */
function buildResearchPrompt(config) {
  const { product, productShortName, persona, targetAudience, researchTopics } = config;

  const system =
    `You are a Plaid product expert preparing for demo video production. ` +
    `Your job is to gather accurate, current information about ${product} so the demo script team ` +
    `can produce a compelling, technically precise walkthrough. ` +
    `Use the ask_plaid_docs tool for authoritative product facts and the glean_chat ` +
    `tool to query Plaid's internal knowledge base for one-pagers, existing demo scripts, ` +
    `and customer success stories. ` +
    `Be thorough — accuracy matters more than speed. Do not invent field names, status codes, ` +
    `or metric ranges; verify everything against official sources.`;

  const topicList = (researchTopics || []).map((t, i) => `${i + 1}. ${t}`).join('\n') ||
    '1. Core features and value proposition\n' +
    '2. Accurate API terminology and field names\n' +
    '3. Typical customer use cases\n' +
    '4. Key differentiators vs. alternatives\n' +
    '5. Any existing demo scripts or product one-pagers';

  const userText =
    `Research ${product} (short name: "${productShortName}") in preparation ` +
    `for a demo video targeting ${targetAudience}.\n\n` +
    `Persona for the demo: ${persona}\n\n` +
    `Use ask_plaid_docs and glean_chat to research the following topics:\n` +
    `${topicList}\n\n` +
    `For each topic, verify claims with at least one tool call before including them.\n\n` +
    `Also search internally for:\n` +
    `- Existing demo scripts or walkthroughs for ${productShortName}\n` +
    `- Customer success stories or case studies\n` +
    `- Any approved messaging or positioning documents\n\n` +
    `When research is complete, output ONLY a single JSON object matching this schema ` +
    `— no prose, no markdown fences, just raw JSON:\n\n` +
    `{\n` +
    `  "product": "<string>",\n` +
    `  "productShortName": "<string>",\n` +
    `  "synthesizedInsights": "<multi-paragraph string: features, value props, differentiators>",\n` +
    `  "accurateTerminology": {\n` +
    `    "statusValues": ["<string>", ...],\n` +
    `    "keyFieldNames": ["<string>", ...],\n` +
    `    "eventNames": ["<string>", ...]\n` +
    `  },\n` +
    `  "customerUseCases": [\n` +
    `    { "industry": "<string>", "useCase": "<string>", "outcome": "<string>" }\n` +
    `  ],\n` +
    `  "internalKnowledge": [\n` +
    `    { "source": "<string>", "snippet": "<string>", "url": "<string>" }\n` +
    `  ],\n` +
    `  "apiSpec": "<string: key endpoints, request/response fields, realistic example values>",\n` +
    `  "existingDemoAssets": [\n` +
    `    { "type": "<script|one-pager|case-study>", "title": "<string>", "url": "<string>" }\n` +
    `  ],\n` +
    `  "researchedAt": "<ISO 8601 timestamp>"\n` +
    `}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Script generation prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that generates a demo-script.json from research + ingested inputs.
 *
 * @param {{
 *   texts: string[],
 *   screenshots: Array<{ base64: string, mimeType: string, label?: string }>,
 *   transcriptions: string[]
 * }} ingestedInputs
 * @param {{
 *   synthesizedInsights: string,
 *   internalKnowledge: Array<{ source: string, snippet: string }>,
 *   apiSpec: string
 * }} productResearch
 * @param {object} [opts]
 * @param {boolean} [opts.requireFinalValueSummarySlide] Enforce final value-summary slide when true (default)
 * @returns {{ system: string, userMessages: Array }}
 */
function buildScriptGenerationPrompt(ingestedInputs, productResearch, opts = {}) {
  const requireFinalValueSummarySlide = opts.requireFinalValueSummarySlide !== false;
  const pipelineAppOnlyHostUi = opts.pipelineAppOnlyHostUi === true;
  const promptEntry = Array.isArray(ingestedInputs.texts)
    ? ingestedInputs.texts.find(t => t && typeof t === 'object' && t.filename === 'prompt.txt')
    : null;
  const promptText = promptEntry?.content || promptEntry?.text || '';
  const productFamily = resolveProductFamily(productResearch, promptText);
  const productProfile = getProductProfile(productFamily);
  const curatedForPrompt = resolveCuratedKnowledgeForPrompt(productResearch, productFamily);
  const curatedKnowledgeBlock = formatCuratedKnowledge(curatedForPrompt);
  const pipelineCtxBlock = formatPipelineRunContextBlock(productResearch.pipelineRunContext);
  const solutionsMasterBlock = formatSolutionsMasterPromptBlock(productResearch.solutionsMasterContext);
  const linkUxSkillBlock =
    productResearch && typeof productResearch.plaidLinkUxSkillMarkdown === 'string'
      ? productResearch.plaidLinkUxSkillMarkdown.trim()
      : '';
  const embeddedLinkMode =
    productResearch && typeof productResearch.plaidLinkMode === 'string'
      ? String(productResearch.plaidLinkMode).toLowerCase()
      : 'modal';
  const embeddedLinkSkillBlock =
    productResearch && typeof productResearch.embeddedLinkSkillMarkdown === 'string'
      ? productResearch.embeddedLinkSkillMarkdown.trim()
      : '';

  const system =
    `You are a senior Plaid demo designer with deep knowledge of Plaid's product ` +
    `portfolio and brand voice. You produce demo scripts that convert prospects and train sales teams.\n\n` +
    `Brand voice rules (non-negotiable):\n` +
    `- Confident, precise, outcome-focused. Never apologetic or jargon-heavy.\n` +
    `- Lead with customer value, not technical implementation details.\n` +
    `- Use active voice: "Plaid verifies the document in real time" not "the document is verified."\n` +
    `- Quantify value where possible: "Signal score 12 — ACCEPT", "verified in under 3 seconds."\n` +
    `- Never use: "simply", "just", "unfortunately", "robust", "seamless".\n` +
    `- Use only approved product names: "Plaid Identity Verification (IDV)", "Plaid Instant Auth", ` +
    `"Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets".\n\n` +
    `Narrative arc (always follow):\n` +
    `1. Problem — friction or compliance challenge\n` +
    `2. Solution entry — Plaid introduced as the answer\n` +
    `3. Frictionless experience — key flow steps\n` +
    `4. Key reveal — the "wow moment" (score, approval, matched data)\n` +
    `5. Outcome — faster, safer, more compliant\n\n` +
    `Quality standards:\n` +
    `- 8–14 steps, 2–3 minutes total\n` +
    `- Narration: 20–35 words per step\n` +
    `- Include a climactic reveal with a quantified outcome\n` +
    `- Use realistic persona data (never generic placeholders)\n` +
    `- No error states, declined flows, or unresolved loading spinners\n\n` +
    `Claims and stats: prefer **CURATED PRODUCT KNOWLEDGE** (verbatim proof points and talk tracks). ` +
    `Use **PRODUCT RESEARCH** mainly for API facts, Gong color, and internal snippets — do not invent numbers.`;

  // Build the multi-part user message content array
  const contentBlocks = [];

  // Research block (object or string)
  contentBlocks.push({
    type: 'text',
    text: `## PRODUCT RESEARCH\n\n${formatSynthesizedInsights(productResearch.synthesizedInsights)}`,
  });

  // Slide output requirements (optional) — keep separate so Haiku does not miss it.
  try {
    if (typeof promptText === 'string') {
      const m = promptText.match(/\[\[SLIDE_OUTPUT_BEGIN\]\]([\s\S]*?)\[\[SLIDE_OUTPUT_END\]\]/);
      if (m && m[1] && m[1].trim()) {
        contentBlocks.push({
          type: 'text',
          text: `## SLIDE OUTPUT REQUIREMENTS\n\n${m[1].trim()}`,
        });
      }
    }
  } catch (_e) { /* best-effort */ }

  contentBlocks.push({
    type: 'text',
    text:
      `## PRODUCT FAMILY\n\n` +
      `Resolved product family: ${productFamily}\n` +
      `Profile label: ${productProfile.label}\n\n` +
      `Product-family-specific accuracy rules:\n${formatProductAccuracyRules(productProfile)}`,
  });

  if (productResearch && productResearch.linkTokenCreate && typeof productResearch.linkTokenCreate === 'object') {
    const imOnly = productResearch.linkTokenCreate.askBillOnlyInvestmentsMoveAuthGet;
    contentBlocks.push({
      type: 'text',
      text:
        `## LINK TOKEN CREATE (script phase — align with research)\n\n` +
        (imOnly
          ? `For **Plaid Investments Move** demos that call **POST /investments/auth/get** after Link, ` +
            `the payload below is **AskBill-only** (no local product heuristics). ` +
            `Match \`/api/create-link-token\` **exactly** to \`suggestedClientRequest\` (merge brand \`client_name\` from persona only).\n\n`
          : `Keep Plaid Link launch steps consistent with this **dynamic** /api/create-link-token payload ` +
            `(from prompt.txt product cues + AskBill during research):\n\n`) +
        `${toJSON(productResearch.linkTokenCreate)}\n\n` +
        `If the demo uses live Link, downstream build will embed these products in the app fetch body.`,
    });
  }

  if (solutionsMasterBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${solutionsMasterBlock}\n\n` +
        `Use this as foundational context for selected solutions (components/APIs + value props) before adding gap-fill facts from AskBill or Glean evidence.`,
    });
  }

  if (linkUxSkillBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${linkUxSkillBlock}\n\n` +
        `Use this specifically for pre-Link and pre-Plaid UX composition, copy hierarchy, CTA labels, and security/value framing.`,
    });
  }
  if (embeddedLinkSkillBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${embeddedLinkSkillBlock}\n\n` +
        `This requirement is mode-specific. If mode is embedded, do not default back to modal Link assumptions.`,
    });
  }

  const skillMd =
    productResearch && typeof productResearch.plaidSkillMarkdown === 'string'
      ? productResearch.plaidSkillMarkdown.trim()
      : '';
  if (skillMd) {
    contentBlocks.push({
      type: 'text',
      text: skillMd,
    });
  }

  if (curatedKnowledgeBlock) {
    contentBlocks.push({
      type: 'text',
      text: curatedKnowledgeBlock,
    });
  }

  if (pipelineCtxBlock) {
    contentBlocks.push({
      type: 'text',
      text: pipelineCtxBlock,
    });
  }

  // Internal knowledge
  if (Array.isArray(productResearch.internalKnowledge) && productResearch.internalKnowledge.length > 0) {
    const snippets = productResearch.internalKnowledge
      .map((k) => `[${k.source}] ${k.snippet}`)
      .join('\n\n');
    contentBlocks.push({
      type: 'text',
      text: `## INTERNAL KNOWLEDGE\n\n${snippets}`,
    });
  }

  // API spec
  if (productResearch.apiSpec) {
    contentBlocks.push({
      type: 'text',
      text: `## API SPEC\n\n${typeof productResearch.apiSpec === 'string' ? productResearch.apiSpec : JSON.stringify(productResearch.apiSpec, null, 2)}`,
    });
  }

  // Gong call insights (from real customer conversations)
  if (productResearch.gongInsights) {
    const gi = productResearch.gongInsights;
    const gongParts = [];
    if (Array.isArray(gi.commonQuestions) && gi.commonQuestions.length > 0) {
      gongParts.push(`Common customer questions:\n${gi.commonQuestions.map(q => `- ${q}`).join('\n')}`);
    }
    if (Array.isArray(gi.customerPainPoints) && gi.customerPainPoints.length > 0) {
      gongParts.push(`Customer pain points:\n${gi.customerPainPoints.map(p => `- ${p}`).join('\n')}`);
    }
    if (Array.isArray(gi.objectionsAndResponses) && gi.objectionsAndResponses.length > 0) {
      gongParts.push(`Objections & responses:\n${gi.objectionsAndResponses.map(o => `- ${typeof o === 'string' ? o : `${o.objection} → ${o.response}`}`).join('\n')}`);
    }
    if (Array.isArray(gi.successStories) && gi.successStories.length > 0) {
      gongParts.push(`Success stories:\n${gi.successStories.map(s => `- ${s}`).join('\n')}`);
    }
    if (gongParts.length > 0) {
      contentBlocks.push({
        type: 'text',
        text: `## GONG CALL INSIGHTS (from real customer conversations — use these to make the demo authentic)\n\n${gongParts.join('\n\n')}`,
      });
    }
  }

  // Sales collateral
  if (Array.isArray(productResearch.salesCollateral) && productResearch.salesCollateral.length > 0) {
    const collateralText = productResearch.salesCollateral
      .map(c => `[${c.type || 'doc'}] ${c.title}\n  Key messages: ${(c.keyMessages || []).join('; ')}`)
      .join('\n\n');
    contentBlocks.push({
      type: 'text',
      text: `## SALES COLLATERAL\n\n${collateralText}`,
    });
  }

  // Text inputs (each item is { filename, content } from ingest.js)
  if (Array.isArray(ingestedInputs.texts) && ingestedInputs.texts.length > 0) {
    const formattedTexts = ingestedInputs.texts.map(t => {
      if (typeof t === 'string') return t;
      const label = t.filename ? `### ${t.filename}\n` : '';
      let content = t.content || '';
      // The slide block is already surfaced separately above; strip it from prompt.txt here
      // so the script model sees one authoritative slide instruction block instead of two.
      if (t.filename === 'prompt.txt') {
        content = content.replace(/\[\[SLIDE_OUTPUT_BEGIN\]\][\s\S]*?\[\[SLIDE_OUTPUT_END\]\]/, '').trim();
      }
      return label + content;
    }).join('\n\n---\n\n');
    contentBlocks.push({
      type: 'text',
      text: `## TEXT INPUTS\n\n${formattedTexts}`,
    });
  }

  // Screenshot image blocks
  if (Array.isArray(ingestedInputs.screenshots)) {
    ingestedInputs.screenshots.forEach((shot, idx) => {
      if (shot.label) {
        contentBlocks.push({
          type: 'text',
          text: `Screenshot ${idx + 1}: ${shot.label}`,
        });
      }
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: shot.mimeType || 'image/png',
          data: shot.base64,
        },
      });
    });
  }

  // Transcriptions (each item is { filename, transcript: { text, words } } from ingest.js)
  if (Array.isArray(ingestedInputs.transcriptions) && ingestedInputs.transcriptions.length > 0) {
    const formattedTranscriptions = ingestedInputs.transcriptions.map(t => {
      if (typeof t === 'string') return t;
      const label = t.filename ? `### ${t.filename}\n` : '';
      const text = t.transcript?.text || t.text || '';
      return label + text;
    }).join('\n\n---\n\n');
    contentBlocks.push({
      type: 'text',
      text: `## TRANSCRIPTIONS\n\n${formattedTranscriptions}`,
    });
  }

  // Schema + instruction
  contentBlocks.push({
    type: 'text',
    text:
      `## OUTPUT SCHEMA: demo-script.json\n\n` +
      `Output ONLY a JSON object matching this schema — no prose, no markdown fences:\n\n` +
      `{\n` +
      `  "product": "<string>",\n` +
      `  "plaidLinkMode": "<modal|embedded>",\n` +
      `  "persona": {\n` +
      `    "name": "<string>",\n` +
      `    "role": "<string>",\n` +
      `    "company": "<string>",\n` +
      `    "useCase": "<string>"\n` +
      `  },\n` +
      `  "totalDurationMs": <number>,\n` +
      `  "steps": [\n` +
      `    {\n` +
      `      "id": "<kebab-case string>",\n` +
      `      "label": "<string>",\n` +
      `      "sceneType": "<host|link|insight|slide>",\n` +
      `      "narration": "<20–35 words, active voice, quantified outcomes>",\n` +
      `      "durationMs": <number>,\n` +
      `      "interaction": {\n` +
      `        "type": "<click|fill|wait|navigate>",\n` +
      `        "target": "<data-testid value in kebab-case>",\n` +
      `        "value": "<string, optional>"\n` +
      `      },\n` +
      `      "linkEvents": [\n` +
      `        { "eventName": "<OPEN|HANDOFF|TRANSITION_VIEW|etc.>", "metadata": {} }\n` +
      `      ],\n` +
      `      "apiResponse": {},\n` +
      `      "visualState": "<brief description of what the screen shows at this step>",\n` +
      `      "plaidPhase": "<launch — use ONLY this value, see rule below>"\n` +
      `    }\n` +
      `  ],\n` +
      `  "ctaText": "<string>",\n` +
      `  "ctaOutcome": "<string>"\n` +
      `}\n\n` +
      `PLAID LINK STEP RULE (CRITICAL — non-negotiable):\n` +
      `When the demo includes Plaid Link, use EXACTLY ONE step for the entire Plaid flow.\n` +
      `Set "plaidPhase": "launch" on that step. Do NOT create separate sub-steps for\n` +
      `consent, OTP, institution selection, account selection, or success screens.\n` +
      `Do NOT create a standalone pre-Link explainer step before launch.\n` +
      `Any trust/value explainer content must be merged into the SAME launch step screen/state.\n` +
      `The recording automation handles those internally via CDP iframe automation.\n` +
      `The single step's narration (≤35 words) must cover all Plaid story beats while matching\n` +
      `what is visible inside the modal, not the button click that triggers it.\n` +
      `e.g. "Recognized as a returning user, Berta confirms with a one-time code,\n` +
      `selects her checking account, and connects in seconds — no credentials required."\n\n` +
      `SCENE METADATA RULE (CRITICAL):\n` +
      `Set sceneType for every step and keep it consistent with structure:\n` +
      `- host: customer-branded host UI step\n` +
      `- link: the single Plaid Link launch step (must also have plaidPhase:"launch")\n` +
      `- insight: Plaid insight step using global api-response-panel; optional deck-style layout may use .slide-root shell (see build prompt) but never host UI\n` +
      `- slide: template-driven slide step that uses .slide-root\n` +
      `Do not label insight steps as slide unless they intentionally render .slide-root.\n\n` +
      `HOST VS SLIDE — ZERO COMPONENT CROSS-REUSE (CRITICAL):\n` +
      `Do not describe or require host demo UI (nav, banners, account cards, dashboard modules) inside slide visualState or slide copy — slides are Plaid-only deck surfaces.\n` +
      `Do not describe or require slide deck shell (.slide-root regions, slide header/footer strips, slide panel grid) inside host, link, or insight visualState.\n` +
      `Narrative may echo themes; DOM/layout systems must stay separate except the shared global #api-response-panel on insight/slide per pipeline contract.\n\n` +
      (requireFinalValueSummarySlide
        ? `FINAL VALUE SUMMARY SLIDE RULE (CRITICAL):\n` +
          `The LAST step in the demo MUST be a Plaid-branded value-summary slide (sceneType:"slide").\n` +
          `Use step id "value-summary-slide" exactly for the final step unless the user explicitly overrides.\n` +
          `This summary slide must synthesize the strongest messaging discovered in PRODUCT RESEARCH,\n` +
          `especially synthesizedInsights.valuePropositions and, when present, SOLUTIONS MASTER\n` +
          `value proposition statements.\n` +
          `Use concise user-benefit language and outcomes. Avoid decorative internal model metrics\n` +
          `or scorecards unless they directly explain a user action or decision.\n` +
          `The final slide visualState must require visible content (Plaid branding, 3-4 value bullets,\n` +
          `and a visible CTA), never a blank placeholder surface.\n\n`
        : `FINAL STEP RULE (NO MARKETING SLIDE MODE):\n` +
          `Do NOT append value-summary-slide or any sceneType:"slide" wrap-up card.\n` +
          `End on a host or insight outcome step that clearly states the completed user result.\n` +
          `Keep the final step narrative-focused and concrete.\n\n`) +
      `ACCURACY RULES (CRITICAL — confirmed via Plaid internal docs and curated product knowledge):\n` +
      `${formatProductAccuracyRules(productProfile)}\n` +
      `- Latency claims: "in real time" is safe. "under one second" is unverified — avoid.`,
  });

  contentBlocks.push({
    type: 'text',
    text:
      `## PLAID LINK IMPLEMENTATION MODE\n\n` +
      `Detected mode from prompt context: ${embeddedLinkMode}\n` +
      `- If mode is "embedded": output "plaidLinkMode":"embedded" and keep Link narration/UI assumptions aligned to embedded in-page flow.\n` +
      `- If mode is "modal": output "plaidLinkMode":"modal" and use standard in-page Plaid Link assumptions.\n`,
  });

  if (pipelineAppOnlyHostUi) {
    contentBlocks.push({
      type: 'text',
      text:
        `## APP-ONLY MODE — HARD CONSTRAINT ON STEP TYPES AND VISUAL CONTENT\n\n` +
        `This is an **app-only** build (\`run-manifest.json\` buildMode=\`app-only\`). The demo must read as a realistic end-user product flow — not a sales-deck walkthrough with Plaid-branded full-viewport interstitials.\n\n` +
        `**Allowed** sceneType values: \`host\`, \`link\`.\n` +
        `**Forbidden** sceneType values: \`insight\`, \`slide\`.\n\n` +
        `CRITICAL — what goes in \`visualState\` vs. \`narration\`:\n\n` +
        `\`visualState\` describes what the **end user** sees on screen. End users of a real retail banking app are **never** shown:\n` +
        `- Plaid API score breakdowns (e.g. "NAME 88 / ADDRESS 95 / PHONE 95 / EMAIL 62").\n` +
        `- Plaid API product names as visible UI copy — "Identity Match", "Signal", "Auth", "Layer", "Plaid Check", "CRA".\n` +
        `- Plaid attribution footers or subtitles — "Powered by Plaid", "via Plaid's name matching algorithm", "using Plaid Auth", "Plaid identity verification".\n` +
        `- Raw API response fields (risk scores, ruleset.result, numbers.ach, match booleans).\n\n` +
        `\`narration\` is the sales voiceover. The narration SHOULD name Plaid products ("Identity Match runs in the background…", "Signal scores return risk…") — that's how the sales story gets told. But the screen the end user sees must read as **their bank's product UI**: plain language confirmations, statuses, and next steps.\n\n` +
        `Concretely:\n` +
        `- DO NOT generate \`sceneType: 'insight'\` or \`sceneType: 'slide'\` steps.\n` +
        `- DO NOT emit \`apiResponse.response\` blocks — there is no JSON rail.\n` +
        `- For a host "verification confirmed" moment, \`visualState\` must describe plain-English customer UI: a green check + "Ownership verified" + bank name + masked account number + Continue button. Use **user-meaningful** copy only: "Verified", "Connected", "Approved", "Ready to transfer". Never: "NAME 88 MATCH", "Identity Match pass", "Signal score 12 ACCEPT".\n` +
        `- \`narration\` for that same step MAY say: "Under the hood, Plaid's Identity Match just confirmed this account belongs to Michael — strong name, address, and phone match with a flagged email formatting difference." That belongs in the voiceover, NOT on the screen.\n` +
        `- Host screens MAY show a brief generic loading banner ("Verifying ownership…" with a progress dot) but MUST NOT render Plaid-branded chrome or API result grids.\n\n` +
        `Recommended app-only arc: host dashboard → host Plaid-Link entry → link launch → host "verifying…" status → host "verified" confirmation (plain UI, no scores) → host success outcome. Plaid product names live in the narration track only.\n`,
    });
  }

  return {
    system,
    userMessages: [{ role: 'user', content: contentBlocks }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. App architecture brief prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that produces a concise architecture brief before app generation.
 *
 * @param {object} demoScript  Parsed demo-script.json object
 * @param {object} [opts]      Options
 * @param {boolean} [opts.plaidLinkLive]  When true, include live Plaid Link architecture notes
 * @param {string}  [opts.plaidSkillBrief] Excerpt from Plaid integration skill (Link, APIs)
 * @param {boolean} [opts.pipelineAppOnlyHostUi] When true (run manifest `app-only`), avoid planning marketing VP surfaces in the host app shell
 * @returns {{ system: string, userMessages: Array }}
 */
function buildAppArchitectureBriefPrompt(demoScript, opts = {}) {
  const system =
    `You are an expert frontend developer who specialises in demo applications ` +
    `for B2B SaaS sales teams. You understand Plaid's design system and the DOM contract ` +
    `that Playwright recording scripts depend on.`;

  let userText = '';
  if (opts.plaidSkillBrief && String(opts.plaidSkillBrief).trim()) {
    userText +=
      `## PLAID INTEGRATION SKILL (reference — product flows)\n\n` +
      `${String(opts.plaidSkillBrief).trim().slice(0, 12000)}\n\n` +
      `Use the skill for Link/token/product ordering; the DOM contract in the next build step is authoritative for the demo app.\n\n`;
  }
  if (opts.embeddedLinkSkillBrief && String(opts.embeddedLinkSkillBrief).trim()) {
    userText +=
      `## EMBEDDED LINK SKILL (mode-specific)\n\n` +
      `${String(opts.embeddedLinkSkillBrief).trim().slice(0, 6000)}\n\n`;
  }

  userText +=
    `Given the following demo script, describe the frontend architecture ` +
    `in approximately 200 words. Cover:\n\n` +
    `1. Number of screens and their logical groupings\n` +
    `2. Step-to-step transitions: subtle, production-like motion only (e.g. 150–300ms opacity or light transform, ` +
    `ease-out; respect prefers-reduced-motion). No flashy page transitions.\n` +
    `3. Mock data needed (names, numbers, scores, API responses)\n` +
    `4. Professional fintech UX motion (encouraged): progress bars or step indicators for multi-step flows; ` +
    `loading states (spinner, skeleton placeholders, disabled primary button + status label); inline status ` +
    `changes (e.g. "Verifying…" → success). Typical banking/payments patterns only.\n` +
    `5. Motion to avoid unless the demo script explicitly asks for it: confetti, particle systems, fireworks, ` +
    `excessive bounce/spring/elastic easing, marquees, celebration explosions, gamified badge showers.\n` +
    `6. Any components shared across multiple steps\n\n` +
    `Keep the description concise and actionable — this brief will be handed to a code ` +
    `generator, not a human developer. No JSON required.\n\n`;

  if (opts.plaidLinkLive) {
    const mode = String(opts.plaidLinkMode || demoScript?.plaidLinkMode || 'modal').toLowerCase() === 'embedded'
      ? 'embedded'
      : 'modal';
    userText +=
      `IMPORTANT — LIVE PLAID LINK MODE:\n` +
      `Resolved mode: ${mode}.\n` +
      (mode === 'embedded'
        ? `Use Embedded Institution Search assumptions: in-page widget mount via Plaid.createEmbedded(token, container).\n` +
          `Do NOT use hosted_link_url redirects/new windows/popups for embedded mode.\n`
        : `Use standard Plaid.create modal assumptions (iframe appears in-app after open()).\n`) +
      `Do NOT describe a mock Plaid Link modal unless explicitly requested by mode.\n` +
      `The architecture should account for token create success checks and deterministic launch signaling.\n\n`;
  }

  if (opts.pipelineAppOnlyHostUi) {
    userText +=
      `## APP-ONLY HOST UI CONSTRAINT\n\n` +
      `This pipeline run is **app-only** (no slides build phase). The scratch HTML must read as a **realistic logged-in product UI**, not marketing collateral.\n` +
      `- Do **not** plan hero strips, outbound headline blocks, or stat grids whose primary job is **value proposition / campaign messaging**.\n` +
      `- Sales value props stay in research artifacts and dashboard **storyboard** narration — the app shell should not mirror them as prominent UI copy.\n\n`;
  }

  userText += `DEMO SCRIPT:\n${toJSON(demoScript)}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

/**
 * Build a deterministic layer contract plan used by layered builds.
 *
 * @param {object} demoScript
 * @param {string} architectureBrief
 * @param {object} [opts]
 * @param {boolean} [opts.mobileVisualEnabled]
 * @param {string} [opts.buildViewMode]  desktop | mobile-auto | mobile-simulated
 * @param {boolean} [opts.pipelineAppOnlyHostUi] app-only runs: no marketing VP polish in host layer-3 checks
 * @returns {{ system: string, userMessages: Array }}
 */
function buildAppFrameworkPlanPrompt(demoScript, architectureBrief, opts = {}) {
  const mode = String(opts.buildViewMode || 'desktop').toLowerCase();
  const mobileVisualEnabled = !!opts.mobileVisualEnabled;
  const system =
    `You are a frontend architecture planner for deterministic demo generation. ` +
    `Output concise implementation contracts only.`;

  let userText =
    `Create a Layered Build Contract in JSON for a demo app generator.\n\n` +
    `Return ONLY valid JSON with this schema:\n` +
    `{\n` +
    `  "layer1Framework": {\n` +
    `    "requiredDomContracts": ["..."],\n` +
    `    "requiredSelectors": ["..."],\n` +
    `    "requiredPanels": ["..."],\n` +
    `    "navigationContract": ["..."]\n` +
    `  },\n` +
    `  "layer2DataInteraction": {\n` +
    `    "apiPanelContract": ["..."],\n` +
    `    "plaidLaunchContract": ["..."],\n` +
    `    "playwrightContract": ["..."]\n` +
    `  },\n` +
    `  "layer3VisualPolish": {\n` +
    `    "brandPolishChecks": ["..."],\n` +
    `    "copyFidelityChecks": ["..."],\n` +
    `    "iconLogoChecks": ["..."]\n` +
    `  },\n` +
    `  "viewMode": "${mode}",\n` +
    `  "mobileVisualEnabled": ${mobileVisualEnabled ? 'true' : 'false'},\n` +
    `  "mobileVisualContract": ["..."]\n` +
    `}\n\n` +
    `Requirements:\n` +
    `- Keep each array concise (3-8 items).\n` +
    `- Use concrete contract statements, not generic advice.\n` +
    `- Include selectors/data-testid requirements from the demo script.\n` +
    `- mobileVisualContract can be empty if mobileVisualEnabled is false.\n` +
    (opts.pipelineAppOnlyHostUi
      ? `- **App-only host policy:** \`layer3VisualPolish.copyFidelityChecks\` must **not** require or encourage pasting Solutions Master / marketing **value proposition** lines into host (customer) screens; keep host copy product-realistic only.\n`
      : '') +
    `\n` +
    `DEMO SCRIPT:\n${toJSON(demoScript)}\n\n` +
    `ARCHITECTURE BRIEF:\n${architectureBrief}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. App generation prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that generates the self-contained demo HTML app and Playwright script.
 *
 * @param {object} demoScript        Parsed demo-script.json
 * @param {string} architectureBrief Plain-text architecture brief from step 3
 * @param {object|null} [qaReport]   Optional QA report from a previous recording pass
 * @param {object} [opts]            Options
 * @param {boolean} [opts.plaidLinkLive]     When true, include live Plaid Link SDK instructions
 * @param {Array}   [opts.plaidLinkScreens]  Captured Plaid Link screenshots [{stepId, base64}].
 *                                           When present, the build agent creates simulated step
 *                                           divs based on the captures instead of using the live
 *                                           SDK iframe for all Plaid Link steps.
 * @param {string}  [opts.designPluginHtml]  assetlib/index.html — pixel-perfect Plaid Link modal ref
 * @param {string}  [opts.designPluginCss]   assetlib/plaid-link.css source
 * @param {object}  [opts.brand]             Brand profile from brand/*.json. Falls back to Plaid defaults.
 * @param {string}  [opts.plaidSkillMarkdown] Plaid integration skill bundle (repo ZIP excerpts)
 * @param {string}  [opts.plaidLinkUxSkillMarkdown] Plaid Link UX markdown skill excerpt
 * @param {boolean} [opts.layeredBuildEnabled] Enable framework->data->polish layering contract
 * @param {object|null} [opts.layeredBuildPlan] Layer contract JSON from framework planning pass
 * @param {boolean} [opts.mobileVisualEnabled] Enable mobile-visual simulator constraints
 * @param {string} [opts.buildViewMode] desktop | mobile-auto | mobile-simulated
 * @param {string} [opts.layerMockTemplate] Optional reusable Layer mobile mock library markdown
 * @param {string} [opts.layerMobileSkeletonHtml] Canonical Layer mobile skeleton HTML (hard contract)
 * @param {string} [opts.buildMode] app | slides (default app)
 * @param {string} [opts.slidePromptTier] full | minimal (default full)
 * @param {boolean} [opts.willRunSlidesPhase] When true, app phase may defer rich slide shell work
 * @param {string} [opts.brandSiteReferenceBase64] Optional PNG base64 of brand site viewport (1440×900) for visual inspiration only
 * @param {boolean} [opts.pipelineAppOnlyHostUi] When true (`run-manifest.json` buildMode `app-only`), strip marketing VP from build-facing research blocks and forbid VP copy in host HTML
 * @returns {{ system: string, userMessages: Array }}
 */
function buildAppGenerationPrompt(demoScript, architectureBrief, qaReport = null, opts = {}) {
  const brand = opts.brand || PLAID_DEFAULT_BRAND;
  const slideTemplateRules = typeof opts.slideTemplateRules === 'string' ? opts.slideTemplateRules : '';
  const slideTemplateCss = typeof opts.slideTemplateCss === 'string' ? opts.slideTemplateCss : '';
  const slideTemplateShellHtml = typeof opts.slideTemplateShellHtml === 'string' ? opts.slideTemplateShellHtml : '';
  const productFamily = opts.productFamily || inferProductFamilyFromText(demoScript?.product || '');
  const productProfile = getProductProfile(productFamily);
  const curatedForPrompt = opts.curatedDigest && Array.isArray(opts.curatedDigest.knowledgeFiles)
    ? opts.curatedDigest
    : buildCuratedDigest(
      opts.curatedProductKnowledge || buildCuratedProductKnowledge(productFamily)
    );
  const pipelineAppOnlyHostUi = !!opts.pipelineAppOnlyHostUi;
  const curatedKnowledgeBlock = formatCuratedKnowledge(curatedForPrompt, {
    omitMarketingDifferentiators: pipelineAppOnlyHostUi,
  });
  const pipelineCtxBlock = formatPipelineRunContextBlock(opts.pipelineRunContext);
  const solutionsMasterBlock = formatSolutionsMasterPromptBlock(opts.solutionsMasterContext, {
    omitValuePropositionStatements: pipelineAppOnlyHostUi,
  });
  const linkUxSkillBlock = typeof opts.plaidLinkUxSkillMarkdown === 'string'
    ? opts.plaidLinkUxSkillMarkdown.trim()
    : '';
  const embeddedLinkSkillBlock = typeof opts.embeddedLinkSkillMarkdown === 'string'
    ? opts.embeddedLinkSkillMarkdown.trim()
    : '';
  const plaidLinkMode = String(opts.plaidLinkMode || demoScript?.plaidLinkMode || 'modal').toLowerCase() === 'embedded'
    ? 'embedded'
    : 'modal';
  const layeredBuildEnabled = !!opts.layeredBuildEnabled;
  const mobileVisualEnabled = !!opts.mobileVisualEnabled;
  const buildViewMode = String(opts.buildViewMode || 'desktop').toLowerCase();
  const buildMode = String(opts.buildMode || 'app').toLowerCase() === 'slides' ? 'slides' : 'app';
  const requestedSlidePromptTier = String(opts.slidePromptTier || 'full').toLowerCase();
  const slidePromptTier = buildMode === 'slides'
    ? 'full'
    : (requestedSlidePromptTier === 'minimal' ? 'minimal' : 'full');
  // In app-only runs there are no slides or insight steps — drop the entire
  // slide template trio from the prompt to reclaim the context window for
  // high-fidelity host UI generation.
  const includeFullSlideTemplate = slidePromptTier === 'full' && !pipelineAppOnlyHostUi;
  const deferredSlidesTrack = buildMode === 'app' && slidePromptTier === 'minimal' && opts.willRunSlidesPhase === true;
  const layerMockTemplate = typeof opts.layerMockTemplate === 'string' ? opts.layerMockTemplate.trim() : '';
  const layerMobileSkeletonHtml =
    typeof opts.layerMobileSkeletonHtml === 'string' ? opts.layerMobileSkeletonHtml.trim() : '';
  const promptText = typeof opts.promptText === 'string' ? opts.promptText : '';
  const useLayerMobileMockTemplate = shouldInjectLayerMobileMockTemplate(demoScript, mobileVisualEnabled);
  const includeLiveLinkInstructionBlock = shouldIncludeLiveLinkInstructionBlock({
    demoScript,
    promptText,
    useLayerMobileMockTemplate,
  });
  const linkTokenCreate = opts.linkTokenCreate && typeof opts.linkTokenCreate === 'object' ? opts.linkTokenCreate : null;
  const linkTokenFetchBodySnippet = formatLinkTokenCreateFetchBodySnippet(linkTokenCreate);
  const buildQaDiagBlock = formatBuildQaDiagnosticSummary(opts.buildQaDiagnosticSummary);

  let cdnRule =
    `- Single index.html file: all CSS and JavaScript inlined.\n` +
    `  EXCEPTION: allow renderjson viewer script in <head>:\n` +
    `  <script src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>\n`;
  if (opts.plaidLinkLive && includeLiveLinkInstructionBlock) {
    cdnRule =
      `- Single index.html file: all CSS and JavaScript inlined.\n` +
      `  EXCEPTIONS in <head>:\n` +
      `  - Plaid Link SDK: https://cdn.plaid.com/link/v2/stable/link-initialize.js\n` +
      `  - JSON viewer: https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js\n`;
  }
  if (brand.typography && brand.typography.googleFontsImport) {
    cdnRule += `  ALSO ALLOWED: the Google Fonts @import specified in the brand design system below (CSS only, in <style> tag).\n`;
  }
  const logoImg = brand.logo || {};
  const primaryBrandImg =
    (logoImg.imageUrl && /^https?:\/\//i.test(logoImg.imageUrl) && logoImg.imageUrl) ||
    (logoImg.iconUrl && /^https?:\/\//i.test(logoImg.iconUrl) && logoImg.iconUrl) ||
    null;
  if (primaryBrandImg) {
    cdnRule +=
      `  ALSO ALLOWED: a single HOST bank <img> — ${primaryBrandImg} (one URL only in nav; no second Brandfetch icon beside wordmark).\n`;
  }

  const system =
    `You are an expert frontend developer generating a self-contained HTML demo ` +
    `application for Plaid. The app will be recorded by Playwright at 1440×900.\n\n` +
    `When a **PLAID INTEGRATION SKILL** block appears in the user message, use it for Link tokens, ` +
    `product API ordering, and sandbox-oriented integration patterns. This prompt's DOM contract ` +
    `(steps, data-testid, panels, Playwright JSON) overrides generic integration advice where they differ.\n\n` +
    `BUILD PHASE FOCUS (mode=${buildMode}):\n` +
    (buildMode === 'slides'
      ? `- Prioritize slide quality and slide contract compliance first (.slide-root, slide copy/state parity, and API JSON rail contract).\n` +
        `- Preserve host app and Plaid interaction wiring unless a slide contract issue requires a shared-shell fix.\n`
      : `- Prioritize host app flow integrity first (step navigation, Plaid launch flow, selector/Playwright contracts, API panel wiring).\n` +
        `- Keep slide steps valid, but optimize for demo-app correctness and deterministic walkthrough coverage.\n` +
        (deferredSlidesTrack
          ? `- Deferred slides track active: keep slide steps structurally valid with concise placeholders; a later slides phase will apply full pipeline slide shell polish.\n`
          : '')) +
    `\n` +
    `DOM CONTRACT (mandatory — Playwright depends on this exactly):\n` +
    cdnRule +
    renderBrandBlock(brand) + `\n` +
    (includeFullSlideTemplate && slideTemplateRules
      ? `SLIDE TEMPLATE RULES (Plaid-only — read carefully):\n${slideTemplateRules}\n\n`
      : '') +
    (includeFullSlideTemplate && slideTemplateCss
      ? `SLIDE TEMPLATE CSS (scoped — embed verbatim in <style>):\n${slideTemplateCss}\n\n` +
        `SLIDE VS HOST APP (critical):\n` +
        `- **ZERO COMPONENT CROSS-REUSE (hard rule):** Do not embed host demo UI (nav, banners, account/overview cards, transfer chrome, host data-testid blocks) inside \`.slide-root\`. Do not put host/link flows inside slide shells. **Plaid insight** steps may reuse the **pipeline slide shell regions** (\`.slide-root\`, \`.slide-header\`, \`.slide-body\`, \`.slide-footer\` from pipeline-slide-shell.html) for deck-style API reveals—especially Plaid Signal / ACH return risk (\`/signal/evaluate\`): use a scoped modifier on \`.slide-root\` (e.g. \`slide-root--signal-insight\`) and reserve ~520px right padding on \`.slide-body\` for the global JSON rail. Give header/footer testids a **step-unique suffix** (e.g. \`-signal-risk\`) so they never duplicate \`value-summary-slide\` testids. Raw JSON only in \`#api-response-panel\`.\n` +
        `- The slide CSS above applies ONLY inside a step div that contains \`.slide-root\` (marketing \`sceneType:slide\` steps **or** Plaid insight steps that adopt the shell).\n` +
        `- Do NOT restyle \`html\` or \`body\` using slide tokens. The HOST BANK UI (nav, cards, TD/chrome, consumer screens, Plaid Link host page) MUST follow the HOST APP DESIGN SYSTEM block only.\n` +
        `- Full-viewport Plaid insight steps: use **either** legacy \`insight-screen\` + \`insight-content\` **or** the slide shell pattern above for Signal-style evaluations; never host chrome. \`sceneType\` in demo-script stays \`insight\` when using the shell for API steps.\n` +
        `- Slides exist only to explain behind-the-scenes API/data; they are Plaid-styled; the rest of the app is customer-branded.\n` +
        `- For API endpoint storytelling slides/insights, keep one raw JSON mechanism only: global \`#api-response-panel\`. Never render duplicate inline raw JSON containers in \`.slide-root\`.\n` +
        `- JSON panel eligibility is endpoint-driven: only steps with explicit \`apiResponse.endpoint\` may use/show JSON panel behavior.\n` +
        `- If a step has \`apiResponse\`, keep the side panel collapsed/hidden by default on initial page load.\n` +
        `- Include one JSON panel edge toggle control: \`data-testid="api-panel-toggle"\` with \`window.toggleApiPanel()\` (no Show/Hide JSON buttons).\n` +
        `- When panel is shown, render JSON fully expanded via renderjson (\`set_show_to_level('all')\` or equivalent).\n` +
        `- Add a global API panel config constant for runtime behavior (collapsed-by-default, expanded JSON level, auto-resize guardrails).\n` +
        `- Use the presentation slide template/rules for JSON panel visual styling; do not invent ad-hoc JSON panel styles.\n` +
        `- Slide content must summarize only high-signal attributes (3-6 bullets) that support the story decision; raw payload remains in global panel.\n` +
        `- API request/response shown in panel must match the slide's claim and endpoint context (no mismatched endpoint narrative).\n` +
        `- **Slide surface:** keep \`.slide-root\` **responsive** per PIPELINE_SLIDE_SHELL_RULES / slide template contract (fluid width/height capped at 1440×900, \`aspect-ratio: 16/10\`). Do not set fixed \`width:1440px;height:900px\` on \`.slide-root\`.\n\n`
      : '') +
    (!includeFullSlideTemplate
      ? `SLIDE TRACK (minimal contract for app-phase creativity):\n` +
        `- Do not spend tokens on full slide-shell polish in this pass.\n` +
        `- Preserve canonical step wrappers and ordering from demo-script.json.\n` +
        `- For sceneType:"slide" steps, render concise, non-empty placeholders with at least a heading and one value/CTA line.\n` +
        `- Do not create duplicate step IDs/testids; keep all existing interaction selectors stable.\n` +
        `- Keep global API panel wiring valid; no inline raw JSON panels in steps.\n` +
        (deferredSlidesTrack
          ? `- A slides follow-up phase will upgrade slide visuals; prioritize host-app richness now.\n\n`
          : '\n')
      : '') +
    (includeFullSlideTemplate && slideTemplateShellHtml
      ? `CANONICAL SLIDE + API PANEL HTML SHELL (structure reference from pipeline-slide-shell.html — merge patterns into index.html; adapt copy per demo-script; omit preview-only script blocks if present):\n` +
        `[[[PIPELINE_SLIDE_SHELL_HTML_BEGIN]]]\n${slideTemplateShellHtml}\n[[[PIPELINE_SLIDE_SHELL_HTML_END]]]\n\n` +
        `SHELL MERGE RULES:\n` +
        `- Match header/body/footer regions, side panels, and JSON control wiring (\`api-panel-toggle\` edge icon + \`toggleApiPanel\`).\n` +
        `- Use renderjson with \`set_show_to_level('all')\` (or deep numeric level) so JSON is fully expanded when the panel is shown.\n` +
        `- Production demos: keep \`__API_PANEL_CONFIG.collapsedByDefault: true\` unless the prompt specifies otherwise.\n\n`
      : '') +
    `- Desktop responsive requirement (MANDATORY): support 1280×800, 1440×900, and 1728×1117 without horizontal clipping or overflow.\n` +
    `  Keep recording parity at 1440×900, but do NOT hard-lock html/body to fixed pixel width/height.\n` +
    `  Use fluid desktop layout (e.g. width:100vw; height:100vh; max-width patterns inside containers).\n` +
    (layeredBuildEnabled
      ? `LAYERED BUILD CONTRACT (MANDATORY):\n` +
        `  - Implement in three logical layers in one final artifact:\n` +
        `    Layer 1 framework: step shells, nav, panels, required data-testid + goToStep/getCurrentStep contracts.\n` +
        `    Layer 2 data/interaction: API panel endpoint+JSON wiring, Plaid launch CTA and Link bootstrap, Playwright step mapping.\n` +
        `    Layer 3 visual/polish: brand fidelity, icon/logo legibility, concise copy matching visualState.\n` +
        `  - Do not skip Layer 1 structural integrity to chase visual polish.\n` +
        `  - If conflicts occur: preserve Layer 1 and Layer 2 contracts first, then simplify Layer 3.\n`
      : '') +
    (mobileVisualEnabled
      ? `MOBILE VISUAL MODE:\n` +
        `  - Build viewMode support: desktop, mobile-auto, mobile-simulated.\n` +
        `  - Default viewMode: ${buildViewMode}.\n` +
        `  - In mobile-simulated mode, render host UI within a phone-like shell wrapper\n` +
        `    data-testid="mobile-simulator-shell" with constrained viewport (~390x844).\n` +
        `  - Auto-mode contract: when the active step is slide-like (sceneType="slide", .slide-root, or step id containing "slide"),\n` +
        `    force desktop presentation automatically for that step. Do NOT render slide steps inside the mobile shell.\n` +
        `  - No user view toggle UI for mobile demos. View mode switching is runtime-automatic per active step.\n` +
        `  - This mode is PRESENTATION-ONLY. Do not claim it validates true Plaid mobile runtime behavior.\n`
      : `DESKTOP-ONLY MODE (MANDATORY):\n` +
        `  - Do NOT render any phone/mobile simulator wrappers.\n` +
        `  - Forbidden in desktop mode: data-testid="mobile-simulator-shell", phone mock frames, mobile-shell classes, mobile view toggles.\n` +
        `  - Keep host app responsive for desktop widths only (1280×800, 1440×900, 1728×1117).\n`) +
    `- Each step: <div data-testid="step-{id}" class="step"> (only one .active at a time)\n` +
    `- Final summary slide contract (CRITICAL):\n` +
    `    - The step id "value-summary-slide" must render as <div data-testid="step-value-summary-slide" class="step">.\n` +
    `    - Do NOT rename or suffix this testid (no -dup variants).\n` +
    (includeFullSlideTemplate
      ? `    - If sceneType is slide, include a visible .slide-root subtree with non-empty heading, value bullets, and CTA text.\n`
      : `    - If sceneType is slide in this pass, placeholders are allowed but must remain non-empty with a visible heading and value/CTA text.\n`) +
    `    - value-summary-slide is narrative-only: do NOT include apiResponse, JSON code blocks, or API side-panel content.\n` +
    `    - Never return a blank placeholder/filler container for this step.\n` +
    `- Global functions:\n` +
    `    window.goToStep(id)       — activate a step by id, fire its link events and API panel\n` +
    `    window.getCurrentStep()   — return the data-testid of the currently active step\n` +
    `- Manual navigation (REQUIRED — add immediately after goToStep/getCurrentStep definitions):\n` +
    `    ArrowRight/ArrowDown = next step. ArrowLeft/ArrowUp = previous step.\n` +
    `    Clicking any non-interactive area of a step also advances to the next step.\n` +
    `    Clicks on button, input, select, textarea, a, [role="button"]/[role="link"] pass through.\n` +
    `    Use this exact implementation (do not alter):\n` +
    `    (function(){\n` +
    `      function _sids(){return Array.from(document.querySelectorAll('.step[data-testid]')).map(function(s){return s.dataset.testid.replace(/^step-/,'');});}\n` +
    `      function _nav(d){var ids=_sids(),cur=(window.getCurrentStep()||'').replace(/^step-/,''),idx=ids.indexOf(cur),n=ids[Math.max(0,Math.min(ids.length-1,idx+d))];if(n&&n!==cur)window.goToStep(n);}\n` +
    `      document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowDown')_nav(1);else if(e.key==='ArrowLeft'||e.key==='ArrowUp')_nav(-1);});\n` +
    `      document.addEventListener('click',function(e){if(e.target.closest('button,input,select,textarea,a,[role="button"],[role="link"]'))return;if(e.target.closest('.side-panel,.api-panel-edge-toggle,.card[onclick*="goToStep"]'))return;_nav(1);});\n` +
    `    })();\n` +
    `- Side panels (always present, always hidden by default — display:none):\n` +
    `    <div id="link-events-panel"  data-testid="link-events-panel"  class="side-panel" style="display:none">\n` +
    `    <div id="api-response-panel" data-testid="api-response-panel" class="side-panel" style="display:none">\n` +
    `  link-events-panel: developer artifact — NEVER shown in any step. Always display:none.\n` +
    `ICONS — ABSOLUTE RULE:\n` +
    `  - Zero emoji anywhere in the HTML. No Unicode emoji, no Markdown-style symbols.\n` +
    `    Not ✅ ❌ 🔒 → ✓ 🏦 💰 🎯 ⚡ ✨ or any other emoji/symbol character.\n` +
    `  - Never hand-draw, merge, or invent icon paths. Use inline Heroicons SVG from stock Heroicons (https://heroicons.com), copied verbatim.\n` +
    `  - Plaid launch CTA icon is pipeline-controlled in modal mode only (for data-testid="link-external-account-btn"); do not add symbol glyphs or custom icon text.\n` +
    `  - Do not wrap the launch CTA contents in flex-grow / fill layouts that scale the icon (e.g. avoid flex:1 on the icon wrapper). The pipeline injects a fixed ~20px Heroicons link SVG + layout CSS.\n` +
    `  - EXCEPTION: exactly ONE Brandfetch bank <img> in the host nav per the design system (wordmark URL, or icon URL only if no wordmark). No second bank <img> beside it.\n` +
    `  - Outline style for UI chrome; solid style for active/filled states.\n` +
    `  - If Heroicons lacks the exact icon, use the closest semantic Heroicons match — never emoji.\n` +
    `  - Feature cards (e.g. link external account): use a clear semantic icon such as "link" or "building-library" — not abstract or merged paths.\n` +
    `PLAID LOGO ASSET CONTRACT (MANDATORY):\n` +
    `  - Never create/draw the Plaid logo from scratch (no inline SVG logo art, no text-only "Plaid" logo, no CSS-generated logo shapes).\n` +
    `  - Use ONLY one of these local files from the HTML root (scratch-app root):\n` +
    `      ./plaid-logo-horizontal-black-white-background.png\n` +
    `      ./plaid-logo-horizontal-white-text-transparent-background.png\n` +
    `      ./plaid-logo-vertical-white-text-transparent-background.png\n` +
    `      ./plaid-logo-text-white-background.png\n` +
    `      ./plaid-logo-no-text-white-background.png\n` +
    `      ./plaid-logo-no-text-black-background.png\n` +
    `  - Choose the file by filename description (horizontal/vertical, white-background, black-background, no-text).\n` +
    `  - Use an <img> tag for Plaid logo usage. Do not hotlink Plaid logo from remote URLs.\n` +
    `  api-response-panel: the ONE AND ONLY mechanism for showing Plaid API JSON responses on endpoint steps.\n` +
    `    - Populate it via a showApiPanel(data) call inside goToStep() for insight steps.\n` +
    `    - Default UX: keep #api-response-panel hidden/collapsed on initial page load (display:none).\n` +
    `    - Add one JSON panel edge-toggle button: data-testid="api-panel-toggle" plus window.toggleApiPanel(). Do not add Show JSON / Hide JSON buttons.\n` +
    `    - On API insight/slide steps, hydrate JSON payloads but keep panel collapsed until toggled open.\n` +
    `    - When opened, render JSON fully expanded via renderjson (set_show_to_level('all') or equivalent).\n` +
    `    - Ensure .side-panel-body is vertically scrollable for long JSON payloads.\n` +
    `      Also allow horizontal scrolling and dynamic panel width resizing so JSON does not bleed off-page.\n` +
    `    - Define a global constant/config object controlling panel behavior for all builds (collapsed default + expanded JSON + auto resize).\n` +
    `    - Use renderjson for JSON rendering:\n` +
    `      <script src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>\n` +
    `      and style keys/strings/numbers to match Plaid slide theme colors.\n` +
    `    - It slides in from the right as a glassmorphism overlay with a light-green edge chevron control that flips direction on collapse/expand.\n` +
    `    - CRITICAL: Do NOT create any inline JSON display panels inside step divs.\n` +
    `      No "insight-right", no "auth-json-panel", no "-json-panel" divs of any kind.\n` +
    `      Every step div shows ONLY the customer-facing demo screen — zero raw JSON in the layout.\n` +
    `      Raw API JSON lives exclusively in api-response-panel. One panel. No duplicates.\n` +
    `    - value-summary-slide must keep api-response-panel hidden and must not include any JSON payload content.\n` +
    `    - On API storytelling steps, body content should call out top response attributes that drive the outcome.\n` +
    `      Examples: Signal risk drivers + recommendation; CRA income stream summary + next payment;\n` +
    `      Identity score + pass threshold/status for happy-path approval.\n` +
    `    - Ensure request/response content aligns with the slide claim: endpoint label, fields, and highlighted bullets\n` +
    `      must describe the same API context.\n` +
    `    - On widescreen layouts, center slide content and add a subtle border/frame around the content area; table scenes should constrain width/padding so columns stay readable and not overly spread.\n` +
    (pipelineAppOnlyHostUi
      ? `APP-ONLY BUILD — HARD CONTRACT (run-manifest buildMode=app-only):\n` +
        `  - There are **zero** Plaid-branded full-viewport interstitials in this run. NO \`.slide-root\`. NO insight chrome. NO value-summary slide.\n` +
        `  - Every step in \`demo-script.json\` has sceneType \`host\` or \`link\` ONLY. If you see anything else, treat it as a host step.\n` +
        `  - Do NOT render \`#api-response-panel\` as a visible or populated element. It MUST stay \`display:none\` on every step and contain no JSON. No \`data-testid="api-panel-toggle"\` button, no \`window.toggleApiPanel()\` call surface — the run is a realistic product flow, not a sales deck.\n` +
        `  - Do NOT hydrate \`window._stepApiResponses\`. There is no JSON rail to populate.\n` +
        `  - Do NOT paste Solutions Master / marketing value-proposition statements into host UI (no hero headlines, marketing ribbons, stat grids, or CTA subcopy whose primary purpose is campaign messaging). VPs stay in research and storyboard narration.\n` +
        `  - Host backgrounds must match the HOST APP DESIGN SYSTEM (light/neutral) throughout.\n\n` +
        `  APP-ONLY CONTENT BAN — no Plaid disclosures in host HTML (CRITICAL):\n` +
        `  A retail banking customer would NEVER see these on a real product page. They only belong in the sales-rep voiceover (storyboard narration). Therefore, on ALL host screens in this run:\n` +
        `  - **No Plaid product names as visible copy**: never write "Identity Match", "Signal", "Auth", "Layer", "Plaid Check", "CRA", "name matching algorithm", "risk score", "ruleset", "ACCEPT/REVIEW/REJECT" into any heading, subtitle, card title, badge, tooltip, footer, or button in the host HTML.\n` +
        `  - **No Plaid attribution strings**: never write "Powered by Plaid", "Powered by Plaid Identity Match", "via Plaid", "using Plaid", "Plaid-powered", or any logo/wordmark that says "Plaid" on a host screen.\n` +
        `  - **No Plaid API score breakdowns**: no grids showing per-field match scores (NAME / ADDRESS / PHONE / EMAIL), no Signal risk score numbers, no "Low risk" / "High risk" pills sourced from API response, no match-boolean lists. These are internal fields customers do not see.\n` +
        `  - **No raw API response values** (numeric or categorical) as visible card content. Do not render \`numbers.ach\`, \`ruleset.result\`, \`scores.*\`, \`is_nickname_match\`, \`is_postal_code_match\`, \`bank_initiated_return_risk.score\`, etc.\n` +
        `  - **No Plaid logos** on host screens (no \`plaid-logo-*.png\` in host chrome, no Plaid wordmark in headers/footers). Plaid logos only appear inside the Plaid Link modal itself, which is owned by the Plaid SDK.\n\n` +
        `  Instead, render **plain customer-facing UI**:\n` +
        `  - "Verification confirmed" with a green check + the institution name + masked account number + Continue.\n` +
        `  - "Account verified" / "Ownership confirmed" — title only, no per-field score grid.\n` +
        `  - "Transfer approved — $500 will be available today."\n` +
        `  - Transient status banner: "Verifying ownership…" with a generic spinner. No Plaid branding, no score values.\n\n` +
        `  If the script narration mentions Plaid API outcomes (Identity Match, Auth, Signal, etc.), that outcome language belongs in the **narration track** (\`demoScript.steps[n].narration\`) only — which the voiceover renders later and the on-screen UI never shows. The host HTML for that same step must still be plain customer UI.\n`
      : '') +
    `HOST UI PROFESSIONALISM (enterprise fintech — non-negotiable for host/customer screens):\n` +
    `  - The host app must read as a credible bank or fintech product UI, not a marketing landing page, Dribbble concept, or game.\n` +
    `  - Visual hierarchy: clear typographic scale, restrained shadows, consistent spacing rhythm, one obvious primary CTA per screen where appropriate.\n` +
    `  - HOST backgrounds: prefer light/neutral surfaces per the HOST APP DESIGN SYSTEM; reserve Plaid-dark treatments for slides (.slide-root) and Plaid insight contexts unless the brief demands otherwise.\n` +
    `  - ANIMATION POLICY: Motion is allowed and appropriate when it matches real fintech products — progress indicators, step bars, loading spinners, skeleton placeholders, short success-state fades, and subtle step transitions (CSS-only or minimal JS). Prefer ease-out and durations under ~350ms for UI chrome.\n` +
    `  - Do NOT use confetti, particle systems, fireworks, elastic/bouncy overshoot, marquees, or decorative celebration effects unless the user prompt explicitly requests them.\n` +
    `  - Avoid heavy animation libraries for decorative effects; CSS transitions/keyframes for progress and loading are sufficient.\n` +
    `  - Typography: use the brand JSON font stack (and allowed Google Fonts import); avoid novelty display fonts for body copy.\n` +
    `HOST UI METRICS GUARDRAIL:\n` +
    `  - Do NOT expose presentation-style internal stats in customer-facing host screens unless they provide clear end-user benefit.\n` +
    `  - Avoid showing Identity score / Signal score / LOW RISK / ACCEPT / coverage % as decorative stat cards in host steps.\n` +
    `  - Prefer user-meaningful outcomes in host UI: "Account funded", "Transfer posted", "Verified", "Next step".\n` +
    `  - Internal model metrics belong in Plaid insight/slide contexts, not core customer UI chrome.\n` +
    `GLOBAL REFINEMENT FEEDBACK (NON-NEGOTIABLE):\n` +
    `  - STEP ACTIVATION CONTRACT: On initial load, exactly one .step must be active, and getCurrentStep() must not return empty during walkthrough.\n` +
    `  - NAVIGATION CONTRACT: goToStep(id) must activate [data-testid="step-\${id}"] reliably and never leave active step as none.\n` +
    `  - SELECTOR CONTRACT: Every selector used by playwright-script.json must exist and be visible on the target step before interaction.\n` +
    `  - LINK LAUNCH CONTRACT: Required launch selectors (apply-financing-btn, continue-application-btn, link-external-account-btn) must be present and visible when referenced.\n` +
    `    Embedded mode exception: do NOT require link-external-account-btn; require plaid-embedded-link-container instead.\n` +
    `  - API PANEL CONTRACT: For API insight steps, #api-response-panel must render non-empty JSON from step API data when shown; never display an empty visible panel.\n` +
    `  - API STORY ALIGNMENT CONTRACT: Endpoint label, response fields, and narration must describe the same API context.\n` +
    `- All interactive elements must have data-testid attributes in kebab-case that match\n` +
    `  the interaction.target field in demo-script.json exactly.\n` +
    `CONSOLE ERROR TRIAGE (MANDATORY):\n` +
    `  - Add runtime guards so token/bootstrap failures are visible and actionable.\n` +
    `  - Capture and log fetch failures for /api/create-link-token, including HTTP status and error payload.\n` +
    `  - If the error message indicates unrecognized request fields, strip helper keys (e.g. linkMode, link_mode)\n` +
    `    from the token request payload and retry once with sanitized body.\n` +
    `  - Never fail silently; expose a clear console.error with remediation context.\n` +
    `ASKBILL PLAID LINK TOKEN PARAMETER VERIFICATION (NON-NEGOTIABLE):\n` +
    `  - Before finalizing any /api/create-link-token request body in generated app code, verify Plaid /link/token/create\n` +
    `    request parameter names and nesting against AskBill.\n` +
    `  - Use AskBill-verified exact field syntax (for example: client_name, products, user.client_user_id,\n` +
    `    country_codes, language, and CRA-specific fields only when explicitly required).\n` +
    `  - Treat linkMode/link_mode as INTERNAL wrapper-only variables used by local server logic.\n` +
    `    They MUST NEVER be included in the payload sent to Plaid /link/token/create.\n` +
    `  - If uncertain about any field name or location, re-check AskBill and omit unknown keys rather than guessing.\n` +
    `- Plaid Link event names to use verbatim:\n` +
    `    OPEN, LAYER_READY, LAYER_NOT_AVAILABLE, SELECT_INSTITUTION, SELECT_BRAND,\n` +
    `    SELECT_DEGRADED_INSTITUTION, ERROR, EXIT, HANDOFF, TRANSITION_VIEW,\n` +
    `    SEARCH_INSTITUTION, SUBMIT_CREDENTIALS, SUBMIT_MFA,\n` +
    `    BANK_INCOME_INSIGHTS_COMPLETED,\n` +
    `    IDENTITY_VERIFICATION_START_STEP, IDENTITY_VERIFICATION_PASS_SESSION,\n` +
    `    IDENTITY_VERIFICATION_FAIL_SESSION, IDENTITY_VERIFICATION_PENDING_REVIEW_SESSION,\n` +
    `    IDENTITY_VERIFICATION_CREATE_SESSION\n\n` +
    `After the HTML, output the Playwright recording script as a JSON fenced code block with\n` +
    `the prefix comment <!-- PLAYWRIGHT_SCRIPT_JSON --> on the line immediately before the block.\n` +
    `The Playwright script JSON schema:\n` +
    `{\n` +
    `  "steps": [\n` +
    `    {\n` +
    `      "id": "<MUST be one of the exact step IDs listed below — no other values allowed>",\n` +
    `      "action": "<goToStep|click|fill|wait>",\n` +
    `      "target": "<goToStep: bare step id ONLY, e.g. \\"td-dashboard\\" — NEVER window.goToStep(...) or JS. click|fill: CSS selector>",\n` +
    `      "value": "<string, optional>",\n` +
    `      "waitMs": <number, optional>\n` +
    `    }\n` +
    `  ]\n` +
    `}\n\n` +
    `REQUIRED: Every step "id" in playwright-script.json MUST exactly match one of these step IDs\n` +
    `from demo-script.json (copy-paste exactly, no modifications):\n` +
    demoScript.steps.map(s => `  "${s.id}"`).join('\n') + '\n' +
    `Do NOT invent new IDs. Do NOT rename, combine, or reorder them. Use only IDs from this list.`;

  const contentBlocks = [];

  contentBlocks.push({
    type: 'text',
    text:
      `## PRODUCT FAMILY\n\n` +
      `Resolved product family: ${productFamily}\n` +
      `Profile label: ${productProfile.label}\n\n` +
      `Product-family-specific accuracy rules for this build:\n${formatProductAccuracyRules(productProfile)}`,
  });

  if (linkTokenCreate && opts.plaidLinkLive && includeLiveLinkInstructionBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `## LINK TOKEN CREATE (dynamic — prompt.txt + AskBill)\n\n` +
        `Research derived POST /api/create-link-token fields from **products named in the prompt** and ` +
        `AskBill (Plaid docs MCP). The app MUST fetch the Link token using this body (replace <BrandName> with the host brand):\n\n` +
        `\`\`\`javascript\n` +
        `body: ${linkTokenFetchBodySnippet}\n` +
        `\`\`\`\n\n` +
        `Resolved object (for consistency with demo-script APIs):\n` +
        `${toJSON(linkTokenCreate)}\n`,
    });
  }

  const brandSiteB64 =
    typeof opts.brandSiteReferenceBase64 === 'string' ? opts.brandSiteReferenceBase64.trim() : '';
  if (brandSiteB64) {
    contentBlocks.push({
      type: 'text',
      text:
        `## BRAND SITE VISUAL REFERENCE (inspiration only)\n\n` +
        `The next image is a **viewport screenshot** (1440×900) of the customer's brand/marketing URL used during brand-extract.\n\n` +
        `Use it **only** for visual inspiration: spacing rhythm, header density, card corner radii, shadow weight, ` +
        `typography scale, button shape, and overall polish. Synthesize a **credible logged-in or authenticated app shell** ` +
        `appropriate to the demo story — do **not** copy the homepage structure verbatim, reproduce marketing or legal copy, ` +
        `or embed this screenshot in the generated HTML/CSS. The HOST APP DESIGN SYSTEM block and brand JSON remain ` +
        `authoritative for colors, fonts, and logo URLs.\n`,
    });
    contentBlocks.push({
      type: 'image',
      source: {
        type:       'base64',
        media_type: 'image/png',
        data:       brandSiteB64,
      },
    });
  }

  const plaidSkillMd = typeof opts.plaidSkillMarkdown === 'string' ? opts.plaidSkillMarkdown.trim() : '';
  if (plaidSkillMd) {
    contentBlocks.push({
      type: 'text',
      text: plaidSkillMd,
    });
  }

  if (curatedKnowledgeBlock) {
    contentBlocks.push({
      type: 'text',
      text: curatedKnowledgeBlock,
    });
  }

  if (pipelineCtxBlock) {
    contentBlocks.push({
      type: 'text',
      text: pipelineCtxBlock,
    });
  }

  if (solutionsMasterBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${solutionsMasterBlock}\n\n` +
        (pipelineAppOnlyHostUi
          ? `Use this block for **API / solution scope** alignment only. Do not lift Solutions Master lines into host marketing surfaces (see APP-ONLY HOST ARTIFACT POLICY in the system contract).`
          : `Where this context conflicts with generic assumptions, follow the listed solution components/APIs.`),
    });
  }

  if (linkUxSkillBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${linkUxSkillBlock}\n\n` +
        `Apply this guidance to host pre-Link UX steps and CTA copy where relevant. Do not contradict DOM contract constraints.`,
    });
  }
  if (embeddedLinkSkillBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `${embeddedLinkSkillBlock}\n\n` +
        `Treat this as implementation-critical whenever Plaid Link mode is embedded.`,
    });
  }
  if (useLayerMobileMockTemplate && layerMockTemplate) {
    if (opts.plaidLinkLive && !includeLiveLinkInstructionBlock) {
      contentBlocks.push({
        type: 'text',
        text:
          `## LAYER MOCK PRIORITY MODE\n\n` +
          `This run indicates a Layer mobile mock prototype. Do NOT inject the full LIVE PLAID LINK MODE instruction block.\n` +
          `Treat Layer mock flow as primary unless the prompt explicitly requires both Layer and live Plaid Link fallback paths.`,
      });
    }
    contentBlocks.push({
      type: 'text',
      text:
        `## LAYER MOBILE MOCK TEMPLATE LIBRARY (REUSABLE)\n\n` +
        `${layerMockTemplate}\n\n` +
        `Apply this template when rendering mobile-simulated Layer moments.\n` +
        `Critical requirements:\n` +
        `- Keep screen 1 host-owned (eligibility capture) and screens 2-4 Layer-owned mock panels.\n` +
        `- Screen 1 should ask for phone to begin onboarding/signup/application; do not present it as an eligibility-check message.\n` +
        `- **Layer mock colors:** Use ONLY the CSS variables \`--layer-brand-accent\`, \`--layer-brand-accent-hover\`, \`--layer-brand-tint-bg\`, \`--layer-phone-input-border\`, \`--layer-host-page-bg-from\`, \`--layer-host-page-bg-to\` for host eligibility chrome AND Layer sheet CTAs, consent card tint, spinners, and bank chip fills. The pipeline injects these from the current run's \`brand.colors\` — do **not** hardcode hex/rgb for Layer or host mobile accents and do **not** introduce parallel primary-color variables (e.g. \`--pm-primary\`) for those surfaces.\n` +
        `- Replace only variable tokens (company/contact/account/address values) to match this demo; preserve canonical Layer template layout/CSS/logo placement/static copy.\n` +
        `- Keep all layer mock screens within the existing mobile simulator shell pattern.\n` +
        `- For mock mode, do not depend on live SDK iframe visibility for these 3 Layer screens.\n` +
        `- Routing contract is mandatory: if user is Layer-eligible, complete onboarding directly and do NOT collect fallback PII.\n` +
        `- Only ineligible users may continue to fallback PII collection and then standard Plaid Link bank linking.\n` +
        `- Include subtle helper text directly below the mobile frame with both routing numbers: 415-555-1111 (eligible) and 415-555-0011 (ineligible fallback).\n` +
        `- Prefill the host phone input with eligible number 415-555-1111 by default.\n`,
    });
  }
  if (useLayerMobileMockTemplate && layerMobileSkeletonHtml) {
    contentBlocks.push({
      type: 'text',
      text:
        `## LAYER MOBILE MOCK — CANONICAL SKELETON (HARD CONTRACT)\n\n` +
        `When this section is present, the generated app MUST conform to the following HTML as the **structural source of truth** for Layer mobile mock layout, ` +
        `CSS patterns (including mobile-shell fill rules), runtime hooks, Plaid logo usage, host visual placeholder, and eligibility helper. ` +
        `Map \`data-testid="step-…"\` and narration copy to this run's demo-script.json and brand; do **not** invent an alternate Layer presentation (different sheet structure, missing helper, duplicate PLAID wordmark, or decorative credit-card hero).\n\n` +
        `Non-negotiable reminders:\n` +
        `- Wrap steps in \`.app-main\`; primary phone chrome carries \`data-testid="mobile-simulator-shell"\` (exact string must appear in HTML for mobile-visual QA).\n` +
        `- Global fixed \`data-testid="layer-eligibility-helper-text"\` with both sandbox numbers and outcomes.\n` +
        `- Layer modal header: \`<img src="./plaid-logo-horizontal-black-white-background.png" alt="Plaid">\` only — wordmark image includes the Plaid name; **remove** any adjacent "PLAID" text.\n` +
        `- Host marketing slot: \`host-use-case-visual-slot\` / \`data-testid="host-use-case-visual-placeholder"\` (set image src per product).\n\n` +
        '### Full canonical reference\n\n```html\n' +
        layerMobileSkeletonHtml +
        '\n```\n',
    });
  }
  if (useLayerMobileMockTemplate) {
    contentBlocks.push({
      type: 'text',
      text: buildLayerShareFieldGuardrailBlock(demoScript),
    });
  }
  contentBlocks.push({
    type: 'text',
    text:
      `## PLAID LINK MODE\n\n` +
      `Resolved Plaid Link mode for this build: ${plaidLinkMode}\n` +
      `- embedded: in-page Embedded Institution Search widget via Plaid.createEmbedded; no hosted_link_url redirects.\n` +
      `- modal: in-page Plaid.create handler flow.\n`,
  });

  if (buildQaDiagBlock) {
    contentBlocks.push({
      type: 'text',
      text: buildQaDiagBlock,
    });
  }

  if (layeredBuildEnabled && opts.layeredBuildPlan) {
    contentBlocks.push({
      type: 'text',
      text:
        `## LAYERED BUILD PLAN\n\n` +
        `Use this contract as hard requirements while generating the final app artifact:\n` +
        `${toJSON(opts.layeredBuildPlan)}`,
    });
  }

  // Refinement context if a QA report is provided
  if (qaReport) {
    const issueLines = [];
    const qaSteps = Array.isArray(qaReport.stepsWithIssues) && qaReport.stepsWithIssues.length > 0
      ? qaReport.stepsWithIssues
      : (Array.isArray(qaReport.steps) ? qaReport.steps : []);
    if (qaSteps.length > 0) {
      for (const stepReport of qaSteps) {
        if (stepReport.issues && stepReport.issues.length > 0) {
          issueLines.push(`Step "${stepReport.stepId}" (score ${stepReport.score}/100):`);
          if (Array.isArray(stepReport.categories) && stepReport.categories.length > 0) {
            issueLines.push(`  Categories: ${stepReport.categories.join(', ')}`);
          }
          stepReport.issues.forEach((issue) => issueLines.push(`  - ${issue}`));
          if (stepReport.suggestions && stepReport.suggestions.length > 0) {
            stepReport.suggestions.forEach((s) => issueLines.push(`  ? ${s}`));
          }
        }
      }
    }

    contentBlocks.push({
      type: 'text',
      text:
        `## REFINEMENT CONTEXT\n\n` +
        `The following issues were found during QA review of the previous build.\n` +
        `Make surgical patches only — do not rewrite the entire app unless a critical structural\n` +
        `issue makes targeted fixes impractical.\n\n` +
        (issueLines.length > 0
          ? issueLines.join('\n')
          : 'No specific issues logged — general quality improvement pass.'),
    });

    if (opts.fixMode === 'touchup') {
      contentBlocks.push({
        type: 'text',
        text:
          `## TOUCHUP MODE (SCOPED)\n\n` +
          `You are in touchup mode. Preserve existing structure and apply minimal targeted edits.\n` +
          `- Do not rewrite unrelated steps.\n` +
          `- Preserve goToStep/getCurrentStep behavior and Plaid launch/token handlers.\n` +
          `- Maintain existing data-testid contract.\n` +
          (opts.touchupStepId
            ? `- Primary scope step: "${opts.touchupStepId}".\n`
            : ''),
      });
    }

    // Attach QA frame screenshots for failed steps so the build agent can see the visual issues
    if (opts.qaFrames && opts.qaFrames.length > 0) {
      contentBlocks.push({
        type: 'text',
        text: `### QA Frames — Visual Evidence of Issues\n\nThe following screenshots are from the failed steps listed above.`,
      });
      for (const frame of opts.qaFrames) {
        contentBlocks.push({
          type: 'text',
          text: `**Step "${frame.stepId}" — ${frame.suffix} frame:**`,
        });
        contentBlocks.push({
          type: 'image',
          source: {
            type:       'base64',
            media_type: 'image/png',
            data:       frame.base64,
          },
        });
      }
    }

    // Include the data-testid inventory from the previous build to prevent regressions
    if (opts.prevTestids && opts.prevTestids.length > 0) {
      contentBlocks.push({
        type: 'text',
        text:
          `### Previous Build — data-testid Inventory\n\n` +
          `These testids were present in the previous build. Preserve them unless explicitly changing an element.\n` +
          opts.prevTestids.map((id) => `  - ${id}`).join('\n'),
      });
    }

  }

  // ── Human reviewer feedback (highest priority — overrides all other guidance) ──
  if (opts.humanFeedback && opts.humanFeedback.trim()) {
    contentBlocks.push({
      type: 'text',
      text:
        `### ⭐ Human Reviewer Feedback — HIGHEST PRIORITY\n\n` +
        `A human has reviewed the demo and provided the following specific feedback.\n` +
        `These instructions take priority over automated QA findings, design system defaults, and ` +
        `architecture brief suggestions. Address every point explicitly.\n\n` +
        opts.humanFeedback.trim(),
    });
  }

  contentBlocks.push({
    type: 'text',
    text: `## DEMO SCRIPT\n\n${toJSON(demoScript)}`,
  });

  contentBlocks.push({
    type: 'text',
    text: `## ARCHITECTURE BRIEF\n\n${architectureBrief}`,
  });

  // Live Plaid Link mode instructions
  if (opts.plaidLinkLive && includeLiveLinkInstructionBlock) {
    const hasCaptures = Array.isArray(opts.plaidLinkScreens) && opts.plaidLinkScreens.length > 0;

    if (false && hasCaptures) {
      // ── Captured-screen mode: DISABLED (reverted to real-SDK mode) ────────
      // Simulated step divs conflict with record-local.js phase detection and cause
      // the recording to show steps in the wrong order. The storyboard now shows
      // the captured screenshots directly from plaid-link-screens/ instead.
      // This block is intentionally disabled.
      contentBlocks.push({
        type: 'text',
        text:
          `## LIVE PLAID LINK MODE — SIMULATED SCREENS\n\n` +
          `The real Plaid Link SDK initialises on page load for token exchange, but the VIDEO shows\n` +
          `SIMULATED Plaid Link step divs that you must build.  Reference screenshots of the actual\n` +
          `Plaid Link sandbox screens are provided below — match the layout and content exactly.\n\n` +
          `Follow these rules precisely:\n\n` +
          `1. SCRIPT TAGS in <head>:\n` +
          `   - <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>\n` +
          `   - <script src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>\n\n` +
          `2. ON PAGE LOAD — initialise the handler silently (no open() call):\n` +
          `   fetch('/api/create-link-token', { method: 'POST',\n` +
          `     headers: { 'Content-Type': 'application/json' },\n` +
          `     body: ${linkTokenFetchBodySnippet} })\n` +
          `   .then(r => r.json())\n` +
          `   .then(data => {\n` +
          `     window._plaidHandler = Plaid.create({\n` +
          `       token: data.link_token,\n` +
          `       onSuccess: function(public_token, metadata) {\n` +
          `         window._plaidPublicToken = public_token;\n` +
          `         window._plaidLinkComplete = true;\n` +
          `         if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch(e) {} }\n` +
          `         if (metadata && metadata.institution) window._plaidInstitutionName = metadata.institution.name;\n` +
          `         if (metadata && metadata.accounts && metadata.accounts[0]) {\n` +
          `           window._plaidAccountName = metadata.accounts[0].name;\n` +
          `           window._plaidAccountMask = metadata.accounts[0].mask;\n` +
          `         }\n` +
          `         window.goToStep('<FIRST_POST_LINK_STEP_ID>');\n` +
          `       },\n` +
          `       onExit: function(err) { console.warn('Plaid exited', err); },\n` +
          `       onEvent: function(name, meta) {\n` +
          `         if (window.addLinkEvent) window.addLinkEvent(name, meta);\n` +
          `       },\n` +
          `     });\n` +
          `   });\n` +
          `   Replace <FIRST_POST_LINK_STEP_ID> with the step ID immediately after the last link-* step.\n\n` +
          `3. INITIATE LINK BUTTON: The button (data-testid="link-external-account-btn") MUST be inside\n` +
          `   the initiate-link step div. Clicking it calls:\n` +
          `     if (window._plaidHandler) window._plaidHandler.open(); // background token exchange\n` +
          `     window.goToStep('<FIRST_LINK_STEP_ID>');               // advance simulated UI\n` +
          `   Replace <FIRST_LINK_STEP_ID> with the ID of the first link-* step.\n\n` +
          `4. SIMULATED PLAID LINK STEP DIVS: Build a step div for EVERY link-* step in the demo script.\n` +
          `   Each div must:\n` +
          `   a. Have data-testid="step-{stepId}" and class="step".\n` +
          `   b. Show a Plaid Link modal overlay: position:fixed, top:0, left:0, width:100%, height:100%,\n` +
          `      backdrop-filter:blur(4px), background:rgba(0,0,0,0.6), z-index:9999,\n` +
          `      with a centred white modal card (width:400px, min-height:500px, border-radius:16px,\n` +
          `      background:#fff, padding:32px).\n` +
          `   c. Contain the Plaid logo at the top of the card (SVG or text "Plaid").\n` +
          `   d. Contain the required data-testid for that step's interaction target (from demo-script.json).\n` +
          `      CRITICAL: every data-testid must be unique across the ENTIRE document — never reuse the same\n` +
          `      testid on multiple step divs. Each link-* step has its own unique container testid:\n` +
          `      - link-consent: data-testid="link-consent-container" on the modal card inner div\n` +
          `      - link-otp: data-testid="otp-input" on the OTP text input (a visible <input>, styled as OTP boxes)\n` +
          `        The step container itself: data-testid="link-otp-container"\n` +
          `      - link-account-select: data-testid="account-select-item" on the first clickable account row\n` +
          `        The step container itself: data-testid="link-account-select-container"\n` +
          `      - link-success: data-testid="link-success-container" on the modal card inner div\n` +
          `      DO NOT use data-testid="plaid-link-modal" anywhere — it is not a required target and causes\n` +
          `      duplicate testid violations when the same name appears in multiple step divs.\n` +
          `   e. Match the captured screenshot as closely as possible (see images below).\n` +
          `   f. NEVER add style="display:..." to a .step div — use only CSS class toggling.\n\n` +
          `5. DYNAMIC BANK DATA: Institution name, account name, and account mask come from the real\n` +
          `   onSuccess callback. Display them using window._plaidInstitutionName,\n` +
          `   window._plaidAccountName, window._plaidAccountMask.  For the simulated screens that\n` +
          `   appear BEFORE onSuccess fires, show placeholder text (e.g. "Your Bank") that gets\n` +
          `   replaced by the goToStep handler for post-link steps.\n` +
          `   For bank logo: always use a generic Heroicons building-library SVG — never fetch real logos.\n\n` +
          `6. COMPLETION FLAG: window._plaidLinkComplete = true is set in onSuccess callback only.\n` +
          `   Also set it in the goToStep handler for the link-success step so the recording does not\n` +
          `   stall if CDP automation completes ahead of the simulated step navigation:\n` +
          `     window._stepLinkEvents['link-success'] = [...];\n` +
          `     // In goToStep for link-success, also set: window._plaidLinkComplete = true;\n\n` +
          `7. PLAYWRIGHT SCRIPT for link-* steps:\n` +
          `   - link-consent: action "goToStep", target "link-consent", waitMs equal to durationMs\n` +
          `   - link-otp: action "fill", target "[data-testid=\\"otp-input\\"]", value "123456",\n` +
          `     followed by action "goToStep" for the next step\n` +
          `   - link-account-select: action "click", target "[data-testid=\\"account-select-item\\"]",\n` +
          `     followed by action "goToStep" for the next step\n` +
          `   - link-success: action "goToStep", target "link-success", waitMs 45000\n` +
          `     (the recording waits for _plaidLinkComplete before advancing)\n\n` +
          `8. POST-LINK STEPS: Hard-code realistic sandbox data:\n` +
          `   - auth/get: account "934816720281", routing "021000021"\n` +
          `   - identity/match: legal_name 97, phone_number 92, email_address 90, address 88\n` +
          `   - signal/evaluate: score 7 (bank-initiated), score 12 (customer-initiated), result "ACCEPT"\n` +
          `     CRITICAL: Signal 0–99 where higher = HIGHER ACH return risk. Scores 5–20 = low risk = ACCEPT.\n` +
          `     NEVER use scores 82–97 — those are high-risk and would receive REVIEW/REROUTE.`,
      });

      // Inject captured screenshots as visual reference
      contentBlocks.push({
        type: 'text',
        text:
          `### Plaid Link Captured Screenshots — Reference for Simulated Step Divs\n\n` +
          `The following screenshots were taken from the real Plaid Link sandbox. ` +
          `Build each simulated step div to match its corresponding screenshot as closely as possible. ` +
          `Pay attention to typography, layout, button styles, and the Plaid colour scheme (#00c5c8 accent).`,
      });
      for (const screen of opts.plaidLinkScreens) {
        contentBlocks.push({
          type: 'text',
          text: `**Captured screen for step "${screen.stepId}":**`,
        });
        contentBlocks.push({
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: screen.base64 },
        });
      }

    } else {
      // ── No-capture mode: real SDK iframe, no simulated step divs ─────────
      contentBlocks.push({
        type: 'text',
        text:
          `## LIVE PLAID LINK MODE\n\n` +
          `${plaidLinkMode === 'embedded'
            ? `This run uses Embedded Institution Search (in-page container) — do NOT build simulated Plaid step divs.\n`
            : `The real Plaid Link SDK renders its own modal UI — do NOT build simulated Plaid step divs.\n`}` +
          `The recording uses headless:false which captures the real Plaid iframe in the video.\n` +
          `Your step list goes directly from the initiate-link step to the post-link customer UI steps.\n\n` +
          `Follow these rules precisely:\n\n` +
          `1. SCRIPT TAGS in <head>:\n` +
          `   - <script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>\n` +
          `   - <script src="https://cdn.jsdelivr.net/npm/renderjson@1.4.0/renderjson.min.js"></script>\n\n` +
          `2. ON PAGE LOAD — initialise the handler silently:\n` +
          `   fetch('/api/create-link-token', { method: 'POST',\n` +
          `     headers: { 'Content-Type': 'application/json' },\n` +
          `     body: ${linkTokenFetchBodySnippet} })\n` +
          `   .then(r => r.json())\n` +
          `   .then(data => {\n` +
          `     window._plaidHandler = Plaid.create({\n` +
          `       token: data.link_token,\n` +
          `       onSuccess: function(public_token, metadata) {\n` +
          `         window._plaidPublicToken = public_token;\n` +
          `         window._plaidInstitutionName = metadata.institution ? metadata.institution.name : '';\n` +
          `         window._plaidAccountName = metadata.accounts && metadata.accounts[0] ? metadata.accounts[0].name : '';\n` +
          `         window._plaidAccountMask = metadata.accounts && metadata.accounts[0] ? metadata.accounts[0].mask : '';\n` +
          `         window._plaidLinkComplete = true;\n` +
          `         if (window._plaidHandler) { try { window._plaidHandler.destroy(); } catch(e) {} }\n` +
          `         window.goToStep('<FIRST_POST_LINK_STEP_ID>');\n` +
          `       },\n` +
          `       onExit: function(err) { console.warn('Plaid exited', err); },\n` +
          `       onEvent: function(name, meta) {\n` +
          `         if (window.addLinkEvent) window.addLinkEvent(name, meta);\n` +
          `       },\n` +
          `     });\n` +
          `   });\n` +
          `   Replace <FIRST_POST_LINK_STEP_ID> with the ID of the step immediately after the\n` +
          `   initiate-link step in the demo script.\n\n` +
          `   CRA/Check REQUIREMENT (when demo uses cra_base_report / cra_income_insights):\n` +
          `   The create-link-token request body MUST include:\n` +
          `     products: ['cra_base_report', 'cra_income_insights']\n` +
          `     consumer_report_permissible_purpose: 'EXTENSION_OF_CREDIT'\n` +
          `     cra_options: { days_requested: 365 }\n` +
          `     productFamily: 'income_insights' (or 'cra_base_report')\n` +
          `     credentialScope: 'cra'\n` +
          `   If CRA_LAYER_TEMPLATE is configured server-side, the backend will use it automatically\n` +
          `   with CRA credentials to initialize the CRA/Layer session token path.\n\n` +
          `${plaidLinkMode === 'embedded'
            ? `3. EMBEDDED LAUNCH (NO BUTTON): Do NOT add "Connect Bank Account", "Link Bank Account", or similar CTA button.\n` +
              `   Embedded mode starts from activating the in-page container (data-testid="plaid-embedded-link-container").\n` +
              `   Do NOT use hosted redirects/popups for embedded mode.\n\n`
            : `3. INITIATE LINK BUTTON: The "Link External Account" button\n` +
              `   (data-testid="link-external-account-btn") MUST be inside the initiate-link step div.\n` +
              `   Clicking it runs: if (window._plaidHandler) window._plaidHandler.open();\n` +
              `   Do NOT call goToStep — the Plaid SDK opens its own iframe modal immediately.\n` +
              `   CRITICAL button-state rules (violating these breaks the recording):\n` +
              `   - The launch button MUST render ENABLED from first paint. Do NOT add a \`disabled\`\n` +
              `     attribute or an \`aria-disabled="true"\` on it. Do NOT start it with a loading-style\n` +
              `     label such as "Preparing secure link…", "Loading…", "Connecting…", or "Initializing…".\n` +
              `     Use a stable action label like "Link external account".\n` +
              `   - Do NOT gate the onclick on a flag that the link-token fetch flips late. If you want\n` +
              `     to guard against clicks landing before Plaid.create() resolves, your onclick handler\n` +
              `     must AWAIT window._plaidHandler (poll with a short interval up to ~10s) and then call\n` +
              `     window._plaidHandler.open(). The handler must never silently no-op on click.\n` +
              `   - If you include a "Preparing…" pre-state for styling reasons, it MUST be swapped to\n` +
              `     "Link external account" before the button becomes clickable, and the swap MUST target\n` +
              `     an element that actually exists in the DOM (use id="link-btn-label" on the label span).\n\n`}` +
          `4. NO SIMULATED PLAID STEPS: Do NOT build step divs for institution search, OTP, credentials,\n` +
          `   account selection, or a Plaid success screen. The real SDK handles all of that inside\n` +
          `   its own cross-origin iframe. The recording automation interacts with the iframe directly.\n\n` +
          `5. POST-LINK STEPS: Hard-code realistic sandbox data in the post-link step divs:\n` +
          `   - auth/get: account "934816720281", routing "021000021", wire routing "021000021"\n` +
          `   - identity/match: legal_name 97, phone_number 92, email_address 90, address 88\n` +
          `   - signal/evaluate: bank_initiated_return_risk { score: 7 }, consumer_initiated_return_risk { score: 12 },\n` +
          `     result "ACCEPT" (CRITICAL: Signal 0–99, higher = HIGHER risk. 5–20 = ACCEPT. NEVER use 82–97.)\n\n` +
          `6. COMPLETION FLAG: window._plaidLinkComplete = true is set ONLY in onSuccess.\n` +
          `   The recording waits for this flag before advancing past the initiate-link step.\n` +
          `   NEVER set _plaidLinkComplete anywhere else — doing so causes the recording to advance\n` +
          `   before Plaid completes and the institution/account screens will not be captured.\n\n` +
          `7. LINK EVENTS: The link-events-panel is a developer artifact — NEVER visible in recordings.\n\n` +
          `8. PLAYWRIGHT SCRIPT — CRITICAL RULES:\n` +
          `   a. The initiate-link step in demo-script.json MUST have "plaidPhase": "launch".\n` +
          `      This tells record-local.js it is the Plaid launch step (disables the overrun timer).\n` +
          `   b. The playwright-script entry for this step must be a SINGLE action.\n` +
          `${plaidLinkMode === 'embedded'
            ? `      Embedded: { "id": "<initiate-link-step-id>", "action": "goToStep", "target": "<initiate-link-step-id>", "waitMs": 120000 }\n` +
              `      Do not use a click target for embedded launch in this mode.\n`
            : `      Modal: { "id": "<initiate-link-step-id>", "action": "click",\n` +
              `        "target": "[data-testid=\\"link-external-account-btn\\"]", "waitMs": 120000 }\n` +
              `      Do NOT split into a goToStep entry + a click entry — that creates duplicate markStep\n` +
              `      calls and corrupts the step-timing.json. One entry, one click, one markStep.\n`}` +
          `   c. Do NOT include playwright steps for institution search, credentials, or account selection.\n` +
          `      The recording automation handles those internally via CDP iframe automation.`,
      });

      if (plaidLinkMode === 'embedded') {
        contentBlocks.push({
          type: 'text',
          text:
            `## EMBEDDED LINK OVERRIDE (HIGHEST PRIORITY)\n\n` +
            `This run is embedded mode. Override any modal/hosted assumptions:\n` +
            `1. Do NOT use hosted_link or hosted_link_url in app code.\n` +
            `2. In launch step, render an in-page container: data-testid="plaid-embedded-link-container".\n` +
            `3. Mount Plaid Embedded Institution Search in that container using Plaid.createEmbedded(...).\n` +
            `4. Build the token request as a standard /link/token/create flow; use the **LINK TOKEN CREATE** ` +
            `products/body from research (prompt-driven + AskBill). Embedded mode does not add hosted_link fields.\n` +
            `5. If "Connect Manually" is needed, use auth.auth_type_select_enabled in token configuration.\n` +
            `6. **NO EXTRA LAUNCH BUTTON.** In embedded mode the user opens the modal by clicking an\n` +
            `   institution tile INSIDE the embedded widget — that IS the launch CTA. Do NOT render\n` +
            `   an additional "Link bank account" / "Connect bank" / "Add account" / "Launch Plaid"\n` +
            `   button anywhere on or around the embedded launch step. Specifically:\n` +
            `   - Do NOT emit <button data-testid="link-external-account-btn">…</button>.\n` +
            `   - Do NOT emit any other button whose onclick calls Plaid.createEmbedded or\n` +
            `     _plaidEmbeddedInstance.open() or window.launchPlaid().\n` +
            `   - Trust copy ("256-bit encryption", "Plaid never stores credentials") and a short\n` +
            `     "Recommended · Instant verification via Plaid" tile are fine; a clickable CTA is not.\n` +
            `7. **CONTAINER SIZING — single pipeline default (all embedded use cases):**\n` +
            `   Use **~430×390px** for #plaid-embedded-link-container: min-width, min-height, height,\n` +
            `   max-width (and width:100% inside the column). This matches the build normalizer and\n` +
            `   skills/plaid-link-embedded-link-skill.md — do not invent small/medium/large variants.\n` +
            `   Respect Plaid's absolute minimum of 350×300 (or 300×350); 430×390 satisfies that.\n` +
            `   Set **height** to the same px as **min-height** — iframes default to 150px tall when the\n` +
            `   parent only has min-height (height:auto).\n` +
            `   EMIT these runtime metadata globals so deterministic QA can verify sizing:\n` +
            `     window.__embeddedLinkUseCase = '<use-case string>';\n` +
            `     window.__embeddedLinkSizeProfile = 'default';\n` +
            `     window.__embeddedLinkExpectedInstitutionTileCount = <N>;\n` +
            `8. Do not add extra iframe/frame containment CSS (display:flex + align-items:center on\n` +
            `   the container forces the widget to the centre with whitespace below). Never use\n` +
            `   overflow:hidden (or overflow-x/y:hidden) on the embed container — it clips the iframe.\n` +
            `   The container should be a normal block element so the Plaid-rendered iframe fills it naturally.\n`,
        });
      }

      // Plaid Link reference screenshots — DISABLED (plaid-link-capture stage off)
      // To restore: re-enable plaid-link-capture in orchestrator.js and uncomment below.
      /*
      if (hasCaptures) {
        contentBlocks.push({
          type: 'text',
          text:
            `### Plaid Link Reference Screenshots (visual context only)\n\n` +
            `These screenshots show what the real Plaid Link sandbox looks like during this demo flow. ` +
            `You do NOT need to recreate these screens — the real SDK renders them. ` +
            `Use these as context for how the app should look AROUND the Plaid Link modal ` +
            `(background dimming, app chrome behind the modal, etc.).`,
        });
        for (const screen of opts.plaidLinkScreens) {
          contentBlocks.push({ type: 'text', text: `**Plaid Link — ${screen.stepId}:**` });
          contentBlocks.push({
            type:   'image',
            source: { type: 'base64', media_type: 'image/png', data: screen.base64 },
          });
        }
      }
      */
    }
  }

  // Design plugin: inject assetlib as pixel-perfect reference for Plaid Link UI
  if (opts.designPluginHtml && includeLiveLinkInstructionBlock) {
    let designBlock =
      `## DESIGN PLUGIN: Plaid Link Asset Library (pixel-perfect reference)\n\n` +
      `The following HTML/CSS is a production-accurate prototype of Plaid Link's Core Credentials ` +
      `flow, derived directly from Plaid's official Product Shots Toolkit Figma file. ` +
      `${plaidLinkMode === 'embedded'
        ? `When generating embedded launch UX, use this as styling/component reference for in-page institution selection and trust surfaces (not a hosted redirect flow). `
        : `When generating the Plaid Link modal steps (institution search, credentials, account selection, connected), use this exact component structure, CSS class names, color tokens, `}` +
      `and layout as your reference. Do NOT deviate from the design tokens defined here.\n\n` +
      `Key design tokens from the asset library:\n` +
      `  --link-bg: #ffffff (modal background)\n` +
      `  --link-teal: #00c5c8 (Plaid accent / CTA)\n` +
      `  --link-black-btn: #1a1a1a (primary button background)\n` +
      `  --modal-w: 400px, --modal-h: 720px\n` +
      `  Institution tiles: 80px × 80px, border-radius 12px\n` +
      `  Account list rows: radio-button pattern, teal selected state\n\n` +
      `### assetlib/plaid-link.css (design tokens and component styles)\n\`\`\`css\n` +
      (opts.designPluginCss || '') +
      `\n\`\`\`\n\n` +
      `### assetlib/index.html (reference prototype)\n\`\`\`html\n` +
      opts.designPluginHtml +
      `\n\`\`\``;
    contentBlocks.push({ type: 'text', text: designBlock });
  }

  contentBlocks.push({
    type: 'text',
    text:
      `Generate the complete index.html and the playwright-script.json as described in the system prompt. ` +
      `Output the HTML first, then the <!-- PLAYWRIGHT_SCRIPT_JSON --> comment, then the JSON fenced block. ` +
      `Nothing else.`,
  });

  return {
    system,
    userMessages: [{ role: 'user', content: contentBlocks }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. QA review prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt for per-step QA review using video frame images.
 *
 * @param {{ id: string, label: string, narration: string, visualState: string }} step
 * @param {string[]} framesBase64  Exactly 3 base64-encoded PNG images [start, mid, end]
 * @param {string}   expectedState Description of what the screen should look like
 * @param {object}   [demoContext] Demo-level context to anchor scoring
 * @param {string}   [demoContext.product]   Product name (e.g. "Plaid Instant Auth + Signal")
 * @param {object}   [demoContext.persona]   { name, role, company, useCase }
 * @param {number}   [demoContext.stepIndex] 0-based index of this step
 * @param {number}   [demoContext.totalSteps] Total steps in the demo
 * @param {object}   [demoContext.prevStep]  { id, label } of preceding step, or null
 * @param {object}   [demoContext.nextStep]  { id, label } of following step, or null
 * @returns {{ system: string, userMessages: Array }}
 */
function buildQAReviewPrompt(step, framesBase64, expectedState, demoContext = {}) {
  const {
    product    = '',
    persona    = {},
    stepIndex  = null,
    totalSteps = null,
    prevStep   = null,
    nextStep   = null,
    narrationStrict = false,
  } = demoContext;

  // Detect whether this step is intentionally Plaid-branded
  const isPlaidBrandedStep = /^plaid-/.test(step.id);

  // Build system prompt with full demo context
  const personaLine = persona.name
    ? `Persona: ${persona.name} (${persona.role || ''} at ${persona.company || ''}). Use case: ${persona.useCase || ''}.`
    : '';
  const productLine = product ? `Product being demoed: ${product}.` : '';
  const stepPosition = (stepIndex !== null && totalSteps !== null)
    ? `This is step ${stepIndex + 1} of ${totalSteps} in the demo.`
    : '';

  const plaidBrandingNote = isPlaidBrandedStep
    ? `\n\nIMPORTANT — PLAID-BRANDED STEP: This step (${step.id}) is intentionally a full-viewport ` +
      `Plaid-branded screen. It is a designed "insight reveal" or outcome screen — NOT a bug. ` +
      `Plaid colors, Plaid logo, Plaid API response panels, and teal/navy design system elements ` +
      `are ALL correct and expected on this step. Do NOT penalize the presence of Plaid branding.`
    : `\n\nIMPORTANT — CUSTOMER-BRANDED STEP: This step should show the customer's (${persona.company || 'brand'}) ` +
      `UI. Plaid UI elements (Plaid logo, Plaid Link modal, Plaid-branded panels) should only appear ` +
      `if the expected visual state explicitly describes them. If Plaid Link modal is open when it ` +
      `should be dismissed, that is a real bug.`;

  const plaidLaunchCtaNote =
    step.plaidPhase === 'launch'
      ? `\n\nADDITIONAL CHECK — PLAID LINK LAUNCH CTA: This step shows the host control that opens Plaid Link. ` +
        `If a leading link/chain icon is visible, it must be modest relative to the button label (roughly text line-height to ~24px — an inline affordance, not a hero graphic). ` +
        `If the icon dominates the button (fills most of the height/width or dwarfs the label), treat that as a UX defect: deduct points, list it in issues, and suggest shrinking the icon or fixing flex/layout so the label remains primary. ` +
        `Apply this check even when the expected visual state does not mention icon size.`
      : '';

  const hasApiResponsePayload =
    step.apiResponse &&
    step.apiResponse.response &&
    typeof step.apiResponse.response === 'object' &&
    !Array.isArray(step.apiResponse.response) &&
    Object.keys(step.apiResponse.response).length > 0;
  const isValueSummaryId = String(step.id || '').toLowerCase() === 'value-summary-slide';
  const apiJsonRailNote =
    hasApiResponsePayload && !isValueSummaryId
      ? `\n\nAPI JSON RAIL CONTRACT: This step includes apiResponse in the demo script. The global right-hand API / JSON side panel (#api-response-panel) should be visible with plausible sample JSON — not only narrative UI in the main slide. If the JSON rail is missing, empty, or raw JSON is only inside the slide body, treat that as a significant defect (deduct materially and list in issues).`
      : '';

  const system =
    `You are a QA engineer reviewing a Plaid product demo recording. ` +
    `${productLine} ${personaLine} ${stepPosition}\n\n` +
    `Your ONLY job is to verify that the recorded frames match the step's "Expected visual state" ` +
    `field. Score strictly against that description — do not apply general assumptions about what ` +
    `Plaid demos "should" look like or invent criteria not present in the expected state. ` +
    `Be specific and actionable in your feedback.` +
    plaidBrandingNote +
    plaidLaunchCtaNote +
    apiJsonRailNote;
  const narrationStrictNote = narrationStrict
    ? `\n\nIMPORTANT — NARRATION-CHECK MODE: This step narration contains concrete anchors (metrics, decisions, or critical outcomes). ` +
      `If narration claims a concrete value/outcome (e.g., ACCEPT/REVIEW, score, amount, percentage, timing), verify that evidence is visible in at least one frame. ` +
      `If not visible, report it as an issue and deduct points.`
    : '';

  // Build step position context string
  const navContext = [
    prevStep ? `Previous step: "${prevStep.id}" — ${prevStep.label}` : 'This is the first step.',
    nextStep ? `Next step: "${nextStep.id}" — ${nextStep.label}` : 'This is the final step.',
  ].join('\n');

  const contentBlocks = [
    {
      type: 'text',
      text:
        `## DEMO CONTEXT\n\n` +
        navContext + `\n\n` +
        `## STEP UNDER REVIEW\n\n` +
        `Step ID:    ${step.id}\n` +
        `Label:      ${step.label}\n` +
        `Narration:  ${step.narration}\n\n` +
        `Expected visual state (score against THIS description only):\n${expectedState}\n` +
        narrationStrictNote + `\n\n` +
        `Below are three frames captured during recording: start of step, midpoint, and end of step.`,
    },
  ];

  const frameLabels = ['Start frame', 'Mid frame', 'End frame'];
  framesBase64.slice(0, 3).forEach((b64, idx) => {
    contentBlocks.push({ type: 'text', text: frameLabels[idx] });
    contentBlocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: b64 },
    });
  });

  contentBlocks.push({
    type: 'text',
    text:
      `Review the frames against the expected visual state and narration above.\n\n` +
      `Scoring rules:\n` +
      `- 100 = frames match the expected state exactly\n` +
      `- Deduct points only for deviations from the expected visual state\n` +
      `- In narration-check mode, deduct points when concrete narration claims are not visibly evidenced in the frames\n` +
      `- Do NOT deduct points for design choices that are consistent with the expected state\n` +
      `- A "critical" issue is one where the step is completely wrong or broken (wrong screen, modal stuck open, blank frame)\n\n` +
      `Output ONLY a JSON object — no prose, no markdown fences:\n\n` +
      `{\n` +
      `  "stepId": "${step.id}",\n` +
      `  "score": <0–100>,\n` +
      `  "issues": ["<specific deviation from expected state>", ...],\n` +
      `  "suggestions": ["<actionable fix>", ...],\n` +
      `  "categories": ["<navigation-mismatch|missing-panel|panel-visibility|prompt-contract-drift|slide-template-misuse|action-failure|plaid-step-uncertainty|plaid-launch-cta-ux>", ...],\n` +
      `  "critical": <true if the step is completely wrong or broken>\n` +
      `}`,
  });

  return {
    system,
    userMessages: [{ role: 'user', content: contentBlocks }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Segmentation prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that maps a raw video analysis to step-timing.json.
 *
 * @param {{ videoIndex: Array, voiceover?: Array }} videoAnalysis  Output of analyze.js
 * @param {{ synthesizedInsights: string }} productResearch
 * @returns {{ system: string, userMessages: Array }}
 */
function buildSegmentationPrompt(videoAnalysis, productResearch) {
  const system =
    `You are a demo video analyst. You segment raw video analysis data into ` +
    `discrete steps by correlating visual changes with voiceover timestamps. ` +
    `Your output drives the Remotion composition timing — precision matters.`;

  const userText =
    `Segment the following video analysis into demo steps.\n\n` +
    `## PRODUCT RESEARCH (for context)\n${productResearch.synthesizedInsights || ''}\n\n` +
    `## WHISPER TRANSCRIPT (word-level timestamps)\n${toJSON(videoAnalysis.voiceover || [])}\n\n` +
    `## FRAME DESCRIPTIONS (1 frame per second)\n${toJSON(videoAnalysis.videoIndex || [])}\n\n` +
    `Output ONLY a JSON object matching this schema — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "totalMs": <number>,\n` +
    `  "totalFrames": <number>,\n` +
    `  "steps": [\n` +
    `    {\n` +
    `      "id": "<kebab-case string matching demo-script step id>",\n` +
    `      "label": "<string>",\n` +
    `      "startMs": <number>,\n` +
    `      "endMs": <number>,\n` +
    `      "durationMs": <number>,\n` +
    `      "startFrame": <number>,\n` +
    `      "endFrame": <number>,\n` +
    `      "durationFrames": <number>\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Narration polish prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that polishes step narration to fit timing and brand voice.
 *
 * @param {Array<{ id: string, narration: string, durationMs: number }>} steps
 * @param {{ synthesizedInsights: string, accurateTerminology: object }} productResearch
 * @returns {{ system: string, userMessages: Array }}
 */
function buildNarrationPolishPrompt(steps, productResearch) {
  const system =
    `You are a senior Plaid copywriter. You polish demo narration to be ` +
    `concise, accurate, and on-brand. Every word must earn its place — the narrator speaks ` +
    `at 150 words per minute and each step has a fixed duration.\n\n` +
    `Brand voice rules:\n` +
    `- Confident, precise, outcome-focused.\n` +
    `- Active voice. Quantified outcomes where possible.\n` +
    `- Never: "simply", "just", "unfortunately", "robust", "seamless".\n` +
    `- Use approved product names only.`;

  // Build per-step instructions with max word count derived from duration
  const stepInstructions = steps.map((step) => {
    const maxWords = Math.floor((step.durationMs / 1000 / 60) * 150);
    return (
      `Step "${step.id}" (${step.durationMs}ms, max ${maxWords} words):\n` +
      `Original: ${step.narration}`
    );
  }).join('\n\n');

  const userText =
    `Polish the narration for each step below. Apply brand voice rules strictly.\n\n` +
    `## PRODUCT RESEARCH (for accuracy checks)\n${productResearch.synthesizedInsights || ''}\n\n` +
    `Accurate terminology to use:\n${toJSON(productResearch.accurateTerminology || {})}\n\n` +
    `## STEPS TO POLISH\n\n${stepInstructions}\n\n` +
    `Output ONLY a JSON object matching the demo-script.json schema with polished narration ` +
    `fields — no prose, no markdown fences. Preserve all other fields unchanged:\n\n` +
    `{\n` +
    `  "steps": [\n` +
    `    {\n` +
    `      "id": "<string>",\n` +
    `      "narration": "<polished narration, within word limit>"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Overlay plan prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt that decides where to add motion graphics overlays.
 *
 * @param {object} demoScript   Parsed demo-script.json (with polished narration)
 * @param {{ videoIndex: Array }} videoAnalysis
 * @returns {{ system: string, userMessages: Array }}
 */
function buildOverlayPlanPrompt(demoScript, videoAnalysis) {
  const system =
    `You are a motion graphics designer for Plaid demo videos. ` +
    `You decide where to add visual overlays that reinforce the narration and ` +
    `direct the viewer's attention to the key reveal moments. ` +
    `Overlays should feel purposeful and premium — never gratuitous.`;

  const userText =
    `Review the polished demo script and frame descriptions below, ` +
    `then produce an overlay plan.\n\n` +
    `Available overlay types:\n` +
    `- zoom_punch:      Zoom into a specific region to highlight a value or element\n` +
    `- callout_badge:   Floating label pointing to a UI element (e.g. "Signal ACCEPT — score 12")\n` +
    `- lower_third:     Title card at the bottom of screen (persona name, step label)\n` +
    `- highlight_box:   Animated rectangle around a specific element\n` +
    `- annotation_text: Short floating text annotation (max 8 words)\n\n` +
    `## DEMO SCRIPT (polished)\n${toJSON(demoScript)}\n\n` +
    `## FRAME DESCRIPTIONS\n${toJSON(videoAnalysis.videoIndex || [])}\n\n` +
    `Output ONLY a JSON object matching this schema — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "overlays": [\n` +
    `    {\n` +
    `      "stepId": "<string>",\n` +
    `      "type": "<zoom_punch|callout_badge|lower_third|highlight_box|annotation_text>",\n` +
    `      "startMs": <number, offset from step start>,\n` +
    `      "durationMs": <number>,\n` +
    `      "region": { "x": <0–1>, "y": <0–1>, "width": <0–1>, "height": <0–1> },\n` +
    `      "text": "<string, for badge/lower_third/annotation types>",\n` +
    `      "rationale": "<one sentence explaining why this overlay is here>"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Script critique prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the prompt for automated quality critique of a generated demo script.
 *
 * @param {object} demoScript     Parsed demo-script.json
 * @param {{ synthesizedInsights: string, accurateTerminology: object }} productResearch
 * @returns {{ system: string, userMessages: Array }}
 */
function buildScriptCritiquePrompt(demoScript, productResearch) {
  const productFamily = resolveProductFamily(productResearch, demoScript?.product || '');
  const productProfile = getProductProfile(productFamily);
  const curatedForPrompt = resolveCuratedKnowledgeForPrompt(productResearch, productFamily);
  const curatedKnowledgeBlock = formatCuratedKnowledge(curatedForPrompt);
  const pipelineCtxBlock = formatPipelineRunContextBlock(productResearch.pipelineRunContext);
  const system =
    `You are a Plaid demo quality reviewer. You evaluate demo scripts against ` +
    `Plaid's quality standards and flag issues before production begins. ` +
    `Be direct and specific — vague praise or criticism is not useful.`;

  const userText =
    `Review the following demo script against the quality criteria below.\n\n` +
    `## QUALITY CRITERIA\n\n` +
    `Narration:\n` +
    `- Each step must have 20–35 words (flag steps with > 35 words as critical)\n` +
    `- Active voice only (flag passive constructions)\n` +
    `- No banned words: "simply", "just", "unfortunately", "robust", "seamless"\n` +
    `- Quantified outcomes in the key reveal step\n\n` +
    `Structure:\n` +
    `- 8–14 steps total\n` +
    `- Must follow narrative arc: Problem → Solution entry → Frictionless experience → Key reveal → Outcome\n` +
    `- A climactic reveal moment with a specific score or metric must be present\n` +
    `- Final step must include a clear CTA or outcome\n\n` +
    `Accuracy:\n` +
    `- Product names must match approved list: "Plaid Identity Verification (IDV)", ` +
    `"Plaid Instant Auth", "Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets"\n` +
    `- No API error responses in the main flow\n` +
    `- Verify terminology against the product research below\n` +
    `${formatProductCritiqueRules(productProfile)}\n\n` +
    `Anti-patterns (flag each occurrence):\n` +
    `- Error states, declined flows, or unresolved loading spinners\n` +
    `- Generic placeholder data (John Doe, example@email.com, etc.)\n` +
    `- Technical API jargon without customer-facing context\n\n` +
    `## PRODUCT FAMILY\n${productFamily} — ${productProfile.label}\n\n` +
    `## PRODUCT RESEARCH (for accuracy verification)\n${productResearch.synthesizedInsights || ''}\n\n` +
    `Approved terminology:\n${toJSON(productResearch.accurateTerminology || {})}\n\n` +
    (curatedKnowledgeBlock ? `${curatedKnowledgeBlock}\n\n` : '') +
    (pipelineCtxBlock ? `${pipelineCtxBlock}\n\n` : '') +
    `## DEMO SCRIPT TO REVIEW\n${toJSON(demoScript)}\n\n` +
    `Output ONLY a JSON object — no prose, no markdown fences:\n\n` +
    `{\n` +
    `  "passed": <true if no critical issues found>,\n` +
    `  "issues": [\n` +
    `    {\n` +
    `      "stepId": "<string or 'global'>",\n` +
    `      "severity": "<critical|warning|suggestion>",\n` +
    `      "rule": "<which quality criterion was violated>",\n` +
    `      "description": "<specific description of the issue>"\n` +
    `    }\n` +
    `  ],\n` +
    `  "suggestions": ["<actionable improvement>", ...]\n` +
    `}`;

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-slide insertion prompt (agent-driven post-slides stage)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a tightly-scoped prompt that asks the model to emit ONE slide fragment
 * for ONE demo-script step. Intentionally does NOT include the giant slide
 * template trio in the *user* content when the host HTML already contains
 * `.slide-root` markup — the model can follow the existing pattern. When the
 * host has no prior slide (fresh app-only run), we pass the shell rules + CSS
 * so the output conforms.
 *
 * Output contract: the model must return a single HTML fragment starting with
 * a `<div data-testid="step-<id>" class="step">` wrapper containing a
 * `.slide-root` element. No scripts, no inline display styles, no markdown
 * fences around the output.
 *
 * @param {object} args
 * @param {object} args.step               Demo-script step for the slide.
 * @param {object} args.brand              Brand JSON (colors, typography).
 * @param {string} args.slideTemplateCss   Optional slide.css source.
 * @param {string} args.slideTemplateRules Optional PIPELINE_SLIDE_SHELL_RULES.md.
 * @param {string} args.slideTemplateShellHtml Optional reference shell HTML.
 * @param {boolean} args.hostHasExistingSlide True when the HTML already has
 *                  `.slide-root` markup we should mirror.
 * @param {Array<string>} [args.valuePropositionStatements] Solutions Master VPs.
 * @param {string} [args.narration]        The step's narration line (for context).
 * @returns {{ system: string, userMessages: Array }}
 */
function buildSlideInsertionPrompt({
  step,
  brand,
  slideTemplateCss = '',
  slideTemplateRules = '',
  slideTemplateShellHtml = '',
  hostHasExistingSlide = false,
  valuePropositionStatements = [],
  narration = '',
} = {}) {
  const brandName = (brand && brand.name) || 'Plaid';
  const stepId = String(step?.id || '').trim();
  const stepLabel = String(step?.label || '').trim();
  const stepVisual = String(step?.visualState || '').trim();
  const effectiveNarration = String(narration || step?.narration || '').trim();
  const endpoint = String(step?.apiResponse?.endpoint || '').trim();

  const system =
    `You are generating ONE Plaid-branded narrative slide as a surgical insertion into an existing demo app's index.html. ` +
    `Follow the host file's existing slide patterns. Do not regenerate the entire page. ` +
    `Return a single HTML fragment wrapped in <div data-testid="step-${stepId}" class="step">...</div> whose child is a .slide-root. ` +
    `Do NOT include <script>, do NOT include inline display styles on the step div, do NOT wrap the output in markdown code fences.`;

  const vps = Array.isArray(valuePropositionStatements)
    ? valuePropositionStatements.slice(0, 4)
    : [];

  let userText =
    `# SLIDE INSERTION — step "${stepId}"\n\n` +
    `Brand: ${brandName}\n` +
    (stepLabel ? `Label: ${stepLabel}\n` : '') +
    (endpoint ? `API endpoint: ${endpoint}\n` : '') +
    (effectiveNarration ? `Narration: ${effectiveNarration}\n` : '') +
    (stepVisual ? `Expected visual: ${stepVisual}\n` : '') +
    `\n## OUTPUT CONTRACT\n` +
    `- Emit ONLY the <div data-testid="step-${stepId}" class="step"> ... </div> fragment.\n` +
    `- Inside, include exactly ONE <div class="slide-root"> ... </div>.\n` +
    `- Use existing host classes (slide-header, slide-body, slide-hero, slide-panels, slide-panel, slide-footer).\n` +
    `- Do NOT add a JSON rail inside the step (the global #api-response-panel handles that).\n` +
    `- Do NOT include emojis. Outline Heroicons SVG only (copy verbatim) when icons are needed.\n\n`;

  if (vps.length) {
    userText +=
      `## APPROVED VALUE PROPOSITIONS (allowed ONLY on slides, not on host app screens)\n` +
      vps.map((v) => `- ${v}`).join('\n') + '\n\n';
  }

  if (hostHasExistingSlide) {
    userText +=
      `## HOST ALREADY HAS SLIDE MARKUP\n` +
      `Mirror the existing host slide markup's classes and density. Do NOT restyle or rewrite shared CSS — it is already in the host file.\n\n`;
  } else {
    if (slideTemplateRules) {
      userText += `## SLIDE SHELL RULES (authoritative)\n${String(slideTemplateRules).slice(0, 6000)}\n\n`;
    }
    if (slideTemplateShellHtml) {
      userText += `## REFERENCE SHELL (structure only — DO NOT copy verbatim)\n\`\`\`html\n${String(slideTemplateShellHtml).slice(0, 4000)}\n\`\`\`\n\n`;
    }
    if (slideTemplateCss) {
      userText +=
        `## SLIDE CSS (available to the host page — do NOT re-emit <style>)\n\`\`\`css\n${String(slideTemplateCss).slice(0, 4000)}\n\`\`\`\n\n`;
    }
  }

  userText +=
    `## STEP JSON (for context only — do not include in output)\n` +
    '```json\n' + toJSON(step) + '\n```\n';

  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-step JSON payload prompt (agent-driven post-panels fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce a prompt that asks the model to emit a realistic Plaid API JSON
 * response for ONE step. Used by post-panels LLM fallback when the existing
 * `apiResponse.response` is sparse or missing narrative-relevant fields.
 *
 * Output contract: the model returns a JSON object (via a single fenced
 * ```json block) whose shape matches Plaid documentation for the endpoint.
 * Must include "top response attributes" that tie to the step narration.
 *
 * @param {object} args
 * @param {object} args.step              Demo-script step.
 * @param {string} [args.existingPayload] Optional JSON.stringify of prior response.
 * @param {string} [args.narrationHint]   Narration / visualState hint string.
 * @returns {{ system: string, userMessages: Array }}
 */
function buildPanelPayloadPrompt({ step, existingPayload = '', narrationHint = '' } = {}) {
  const stepId = String(step?.id || '').trim();
  const endpoint = String(step?.apiResponse?.endpoint || '').trim();
  const hint = String(narrationHint || step?.visualState || step?.narration || '').trim();
  const system =
    `You generate realistic Plaid API JSON response bodies for sales demo apps. ` +
    `You do NOT invent Plaid endpoints. You return ONLY a single JSON object inside one fenced json code block. ` +
    `No narration, no explanation, no field you cannot justify from Plaid documentation.`;
  let userText =
    `# API PAYLOAD FOR step "${stepId}"\n\n` +
    (endpoint ? `Endpoint: ${endpoint}\n` : '') +
    (hint ? `Narrative hint: ${hint}\n` : '') +
    `\n## REQUIREMENTS\n` +
    `- Output exactly one \`\`\`json fenced block containing a JSON object.\n` +
    `- Include the top response attributes that drive the outcome in the demo narration.\n` +
    `- Use values consistent with a U.S. consumer sandbox account; no PII.\n` +
    `- Keep payload realistic but compact (< 60 top-level keys).\n`;
  if (existingPayload && existingPayload.trim()) {
    userText +=
      `\n## EXISTING (sparse) PAYLOAD — improve on this, do not regress required fields\n\`\`\`json\n${existingPayload}\n\`\`\`\n`;
  }
  return {
    system,
    userMessages: [{ role: 'user', content: userText }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildResearchPrompt,
  buildScriptGenerationPrompt,
  buildAppArchitectureBriefPrompt,
  buildAppFrameworkPlanPrompt,
  buildAppGenerationPrompt,
  buildQAReviewPrompt,
  buildSegmentationPrompt,
  buildNarrationPolishPrompt,
  buildOverlayPlanPrompt,
  buildScriptCritiquePrompt,
  buildSlideInsertionPrompt,
  buildPanelPayloadPrompt,
  shouldInjectLayerMobileMockTemplate,
};
