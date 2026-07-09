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
const { parseColor, relativeLuminance } = require('./brand-contrast');
const { pickDarkWordmarkUrl } = require('./host-nav-logo-contrast');
const { SLIDE_HOST_ISOLATION_BLOCK } = require('./slide-design-skill');

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
  const hb = brand.hostBanner || null;
  const bannerBg = (hb && hb.bg) || c.navBg || '#ffffff';
  const bannerParsed = parseColor(bannerBg);
  const bannerLum = bannerParsed ? relativeLuminance(bannerParsed) : 1;
  const useLightBanner = bannerLum > 0.6 || !!(hb && hb.fallback);
  const logoShellBg = useLightBanner
    ? '#ffffff'
    : (logo.shellBg || 'transparent');
  const logoShellBorder = useLightBanner
    ? 'rgba(0, 0, 0, 0.08)'
    : (logo.shellBorder || 'transparent');
  const primaryWordmark = useLightBanner ? pickDarkWordmarkUrl(brand) : null;
  const logoCandidates = Array.from(
    new Set(
      (useLightBanner
        ? [primaryWordmark, logo.imageUrl, logo.iconUrl]
        : [logo.darkImageUrl, logo.imageUrl, logo.iconUrl])
        .map((u) => String(u || '').trim())
        .filter((u) => /^https?:\/\//i.test(u))
    )
  );

  const lines = [];
  lines.push(`- HOST APP DESIGN SYSTEM — ${brand.name} brand (applies to app chrome only; Plaid Link modal is always white/Plaid-branded):`);

  // Colors — LIGHT-HOST FLOOR (2026-07-01). Host SURFACES (page + content cards)
  // are ALWAYS light with dark text, regardless of the brand's mode. brand-extract
  // non-deterministically classifies some hosts as mode:"dark" and emits a dark
  // bgPrimary; if that dark color is used as the host page/card background the
  // build renders black-on-black (dark text on the dark brand surface — Gringo
  // 2026-07-01: mode flipped light→dark run-to-run). Per CLAUDE.md the host
  // defaults to light; the brand's dark color is for the nav/banner + accents ONLY.
  const _bgParsed = parseColor(c.bgPrimary);
  const _bgLum = _bgParsed ? relativeLuminance(_bgParsed) : 1;
  const _hostDark = String(brand.mode || '').toLowerCase() === 'dark' || _bgLum < 0.5;
  const hostBg    = _hostDark ? '#ffffff' : (c.bgPrimary   || '#ffffff');
  const hostCard  = _hostDark ? '#ffffff' : (c.surfaceCard || '#ffffff');
  const hostText1 = _hostDark ? '#111827' : (c.textPrimary   || '#111827');
  const hostText2 = _hostDark ? '#4b5563' : (c.textSecondary || '#4b5563');
  const hostText3 = _hostDark ? '#6b7280' : (c.textTertiary  || '#6b7280');
  lines.push(`    Mode:              light` + (_hostDark ? `  (brand palette is dark; host surfaces forced light — see LIGHT-HOST RULE below)` : `  (host surfaces are light)`));
  if (!_hostDark && c.bgGradient) {
    lines.push(`    Background:        ${hostBg} or ${c.bgGradient}   (host PAGE + cards)`);
  } else {
    lines.push(`    Background:        ${hostBg}   (host PAGE + cards — light; dark text on top)`);
  }
  lines.push(`    Primary CTA color: ${c.accentCta}`);
  lines.push(`    Text primary:      ${hostText1}`);
  lines.push(`    Text secondary:    ${hostText2}`);
  lines.push(`    Text tertiary:     ${hostText3}`);
  lines.push(`    Accent border:     ${c.accentBorder}`);
  lines.push(`    Accent bg tint:    ${c.accentBgTint}`);
  lines.push(`    Error color:       ${c.error}`);
  lines.push(`    Success color:     ${c.success}`);
  lines.push(`    Card surface:      ${hostCard}   (light — never a dark brand color)`);
  if (c.navBg)            lines.push(`    Nav background:    ${c.navBg}   (chrome ONLY — may be the brand's dark color)`);
  if (c.navAccentStripe)  lines.push(`    Nav accent stripe: ${c.navAccentStripe}`);
  if (c.footerBg)         lines.push(`    Footer background: ${c.footerBg}   (chrome ONLY)`);
  if (_hostDark) {
    lines.push('');
    lines.push(`    ⚠ LIGHT-HOST RULE (authoritative): ${brand.name}'s brand palette is dark, but the DEMO host page and every content card MUST be light (${hostBg}) with dark text (${hostText1}). Reserve the brand's dark color (${c.bgPrimary}) for the top nav/banner + footer chrome and accents ONLY — never the page background or content cards, and never place dark text on a dark surface. (Dark full-bleed surfaces are reserved for the Plaid Link modal / Plaid slides.)`);
  }

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
      lines.push(`      FALLBACK MODE: brand tokens could not guarantee logo visibility on the brand's preferred nav color. Use a WHITE banner with the accent stripe (${hb.accentStripe || 'brand accent'}) as a bottom border. Logo shell MUST use background #ffffff — never place a dark wordmark on a dark nav.`);
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
      `      exactly ONE bank mark in the header/nav per step. Do NOT add a second Brandfetch <img> beside it.\n` +
      `      USE THE PROVIDED ASSET (HARD): the nav logo MUST be <img src="${primaryLogo}"> — the real supplied logo file.\n` +
      `      Do NOT redraw or substitute the logo as an inline <svg>, a data: URI (e.g. data:image/svg+xml), a CSS-drawn\n` +
      `      glyph, or an icon-font mark. A self-drawn logo is a build defect; the pipeline supplies the official asset\n` +
      `      and will overwrite a fabricated one. The decorative logo "shell"/"mark" container may stay, but its inner\n` +
      `      content must be this <img>, not a hand-drawn shape.`
    );
  }
  if (logo.wordmark) {
    const svgVal = logo.svgOrEmoji && !logo.svgOrEmoji.match(/\p{Emoji}/u) ? `${logo.svgOrEmoji} ` : '';
    lines.push(`    Logo (text fallback): ${svgVal}"${logo.wordmark}" — color ${logo.color || c.accentCta}, ` +
      `${logo.fontSize}/${logo.fontWeight}, letter-spacing ${logo.letterSpacing || 'normal'}` +
      (logo.imageUrl ? ` (use only if images fail to load)` : ''));
  }

  // Nav consistency is scoped PER SURFACE, not globally. Within one host surface the nav should stay
  // identical (fixes the "logo disappears past page 1" / stranded-wordmark bugs); but a story may
  // deliberately navigate to a DIFFERENT surface (partner / referral / co-branded / marketplace /
  // third-party page) that legitimately has its own brand + chrome — do not force this lockup there.
  lines.push(
    `    HOST NAV — CONSISTENT WITHIN A SURFACE (default, not a blanket rule):\n` +
    `      - Treat the top-nav as ONE reusable component PER SURFACE. For every step that stays on the SAME\n` +
    `        ${brand.name || 'host'} surface, emit the SAME nav markup — the brand logo image AND the wordmark on each\n` +
    `        of those steps. Within one surface, do NOT drop the logo image or shrink the nav to a wordmark-only header\n` +
    `        on later steps — a real product keeps its header identical page to page.\n` +
    `      - GROUP the logo image and the wordmark inside ONE lockup container, e.g.\n` +
    `          <div style="display:inline-flex;align-items:center;gap:10px;flex:0 0 auto"><img …><span class="wordmark">${brand.name || 'Brand'}</span></div>\n` +
    `        Do NOT place the logo and the wordmark as SEPARATE flex children of a justify-content:space-between nav —\n` +
    `        that strands the wordmark in the CENTER of the bar. Layout is: logo+wordmark lockup = LEFT group; nav\n` +
    `        links / account chip = RIGHT. (This grouping rule applies to whatever nav a surface uses.)\n` +
    `      - EXCEPTION — deliberate surface change: when the story/visualState moves to a DISTINCT surface (a lending\n` +
    `        referral or partner page, a co-branded handoff, a marketplace, or any explicitly different brand/site),\n` +
    `        that step SHOULD get its own appropriate nav, brand mark, and styling — do NOT force ${brand.name || 'the primary'}'s\n` +
    `        lockup onto it. Consistency is per-surface; a new surface is a new (internally-consistent) nav. When in\n` +
    `        doubt, follow the step's visualState: same app → same nav; new destination → its own chrome.\n` +
    `      - Keep data-testid="host-bank-logo-shell"/"host-bank-logo-img" on the FIRST step of the primary surface ONLY\n` +
    `        (testids stay unique); repeat the identical visual lockup (img + wordmark) on that surface's other steps\n` +
    `        WITHOUT those testids.`
  );

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

  // Verified nav items (from brand-references library or auto-crawl).
  // The build LLM should match these labels and order — paraphrasing
  // results in nav bars that don't look like the real customer's app.
  const navItems = (brand.nav && Array.isArray(brand.nav.items)) ? brand.nav.items : [];
  const navKind = String((brand.nav && brand.nav._kind) || '').toLowerCase();
  const marketingNav =
    navKind === 'marketing' ||
    (navKind !== 'customer-app' && navKind !== 'app' && navItems.length > 0 &&
      (() => {
        try {
          const BF = require('./brand-fidelity');
          return BF.looksLikeMarketingNav(navItems);
        } catch (_) {
          return false;
        }
      })());
  if (navItems.length > 0 && !marketingNav) {
    const labelList = navItems.map(it => it.label || '').filter(Boolean).join(' | ');
    lines.push('');
    lines.push(`    HOST APP NAV — VERIFIED LABELS (use these exact strings, in this order):`);
    lines.push(`      ${labelList}`);
    if (brand.nav._source) {
      lines.push(`      _source: ${brand.nav._source}`);
    }
    lines.push(`      RULE: do NOT paraphrase nav labels. "Bill Pay" is not "Pay Bills"; "Accounts" is not "My Accounts".`);
  } else if (marketingNav) {
    lines.push('');
    lines.push(`    HOST APP NAV — CUSTOMER CHECKOUT (marketing-site crawl ignored):`);
    lines.push(`      Do NOT paste zip.co / marketing mega-menu labels into the host app.`);
    lines.push(`      Checkout host: Shop | Pay in 4 | Help | Business`);
    lines.push(`      Underwriting host: Underwriting | Queue | Policies | Help`);
    lines.push(`      Pick ONE nav set per screen; use short labels (≤20 chars each).`);
  }

  // Verified hero copy patterns (from brand-references — auto-crawl rarely
  // captures these reliably). The model should pick ONE pattern and use it.
  const heroPatterns = (brand.hero && Array.isArray(brand.hero.patterns)) ? brand.hero.patterns : [];
  if (heroPatterns.length > 0) {
    lines.push('');
    lines.push(`    HOST APP HERO COPY — VERIFIED PATTERNS (use one of these verbatim):`);
    heroPatterns.slice(0, 6).forEach(p => lines.push(`      - ${p}`));
  }

  // Footer disclosures — REGULATORY text. These are facts the LLM cannot
  // invent or paraphrase without legal risk to the customer (FDIC, Equal
  // Housing Lender, NMLS ID).
  const footer = brand.footer || {};
  const disclosures = Array.isArray(footer.disclosures) ? footer.disclosures : [];
  const hasFooter = disclosures.length > 0 || footer.copyright || footer.nmlsId;
  if (hasFooter) {
    lines.push('');
    lines.push(`    HOST APP FOOTER — VERBATIM REGULATORY TEXT (must appear on at least one host screen):`);
    disclosures.forEach(d => lines.push(`      - ${d}`));
    if (footer.copyright) lines.push(`      - ${footer.copyright}`);
    if (footer.nmlsId) lines.push(`      - ${footer.nmlsId}`);
    lines.push(`      RULE: copy these strings VERBATIM. Do not rephrase, abbreviate, or "modernize".`);
  }

  // Brand motifs (visual signatures that ID the customer at a glance).
  if (Array.isArray(brand.motifs) && brand.motifs.length > 0) {
    lines.push('');
    lines.push(`    HOST APP MOTIFS (specific to this brand — do not invent generic alternatives):`);
    brand.motifs.slice(0, 8).forEach(m => lines.push(`      - ${m}`));
  }

  // Account-number masking convention.
  if (brand.masking && brand.masking.pattern) {
    lines.push('');
    lines.push(`    ACCOUNT MASKING (use this convention everywhere account numbers appear):`);
    lines.push(`      ${brand.masking.pattern}`);
  }

  // Transaction-feed examples (the build LLM mirrors these when listing
  // transactions; this is what stops "Direct Deposit" generic strings from
  // appearing on what should be a real bank statement feed).
  if (Array.isArray(brand.transactionFeedExamples) && brand.transactionFeedExamples.length > 0) {
    lines.push('');
    lines.push(`    TRANSACTION FEED FORMAT (mimic this shape — ALL CAPS merchants, posted-date markers):`);
    brand.transactionFeedExamples.slice(0, 4).forEach(t => lines.push(`      - ${t}`));
  }

  return lines.join('\n');
}

// REMOVED (2026-05-29): Plaid Layer is no longer built as a mobile mockup.
// Layer is always implemented with the REAL Plaid Layer Web SDK (Plaid.create +
// handler.submit/open), exactly like Plaid Link — a live modal that loads. This
// permanently returns false so no mock-Layer template / mobile-frame / helper-
// text scaffolding is ever injected; the live `useLayerWebSdk` block always runs.
function shouldInjectLayerMobileMockTemplate() {
  return false;
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
/**
 * Strip prompt-level "no slides / app-only" directives from a user prompt body.
 *
 * Used when the orchestrator is running with --with-slides but the user prompt
 * was authored from the app-only template and still contains directives like
 * "NO-SLIDE REQUIREMENT" or "Do not generate `sceneType: 'slide'` steps".
 * Without this strip, the script generator obeys the prompt-level instruction
 * (more specific) and silently produces an app-only script even though slides
 * were requested.
 *
 * Returns the cleaned content. Idempotent and safe — leaves prompts that don't
 * contain these patterns untouched.
 */
function stripPromptLevelNoSlidesDirectives(content) {
  if (typeof content !== 'string' || !content) return content;
  let out = content;

  // 1. Block-headed sections like:
  //      NO-SLIDE REQUIREMENT (KEEP THIS IN PROMPT)
  //      ----------
  //      This demo is APP-ONLY...
  //    ...up to the next section heading (a line of '-' or '=' or a new ALL-CAPS heading).
  out = out.replace(
    /^[-=]{3,}\s*\n\s*NO[-\s]?SLIDE[^\n]*\n[-=]{3,}\s*\n[\s\S]*?(?=\n[-=]{3,}\s*\n[A-Z]|\n={3,}\s*$|$)/gmi,
    ''
  );
  // 2. Inline ALL-CAPS heading without surrounding rule lines.
  out = out.replace(
    /^NO[-\s]?SLIDE\s+REQUIREMENT[^\n]*\n[\s\S]*?(?=\n[A-Z][A-Z\s]+\n[-=]{3,}|\n[-=]{3,}\s*\n|\n##|$)/gmi,
    ''
  );
  // 3. Standalone directive lines (case-insensitive). These are surgical removals
  //    that keep surrounding bullet/checkbox lists intact.
  const directivePatterns = [
    /^\s*This demo is APP-ONLY\.?[^\n]*\n?/gmi,
    /^\s*Do NOT generate\s+`?sceneType[^`]*`?\s*[:=]?\s*['"]?slide['"]?[^\n]*\n?/gmi,
    /^\s*Do not generate\s+`?sceneType[^`]*`?\s*[:=]?\s*['"]?slide['"]?[^\n]*\n?/gmi,
    /^\s*Do NOT add a final value[- ]summary slide[^\n]*\n?/gmi,
    /^\s*Do not add a final value[- ]summary slide[^\n]*\n?/gmi,
    /^\s*End on a host (or insight )?outcome step[^\n]*\n?/gmi,
    /^\s*[-*]?\s*\[[xX ]\]\s*No slide beats included[^\n]*\n?/gmi,
    /^\s*[-*]?\s*\[[xX ]\]\s*App[- ]only env flags used[^\n]*\n?/gmi,
  ];
  for (const re of directivePatterns) out = out.replace(re, '');

  // Collapse the blank lines we just created (≥3 newlines → 2).
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

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

  // Host-company context (Brandfetch Brand Context API, fetched in research). SUPPLEMENTARY
  // background only — adds realistic color to the persona/scenario/host-app surfaces, but it is
  // LOWER AUTHORITY than the prompt and the internal research (Glean / AskBill / curated product
  // knowledge / Solutions Master). On ANY conflict, the prompt + internal research win
  // (operator directive 2026-06-25).
  const hostCtx = productResearch && productResearch.hostCompanyContext;
  const hostCompanyContextBlock =
    hostCtx && typeof hostCtx.markdown === 'string' && hostCtx.markdown.trim()
      ? `HOST COMPANY CONTEXT — ${hostCtx.domain} (SUPPLEMENTARY background from Brandfetch — LOWER AUTHORITY).\n` +
        `Use it ONLY to add realistic color to the persona, scenario, and host-app surfaces.\n` +
        `PRECEDENCE — the SOURCE OF TRUTH is the user's prompt and the internal research above (Glean / AskBill /\n` +
        `curated product knowledge / Solutions Master). If anything below conflicts with the prompt or that\n` +
        `internal research — company facts, products, persona, value props, the storyboard, or any other detail —\n` +
        `IGNORE the conflicting part here and follow the prompt + research. Never let this override them.\n\n` +
        hostCtx.markdown.trim()
      : '';

  // ── Three-tier story handling ─────────────────────────────────────────────
  // Detect whether the user wrote an explicit storyboard, gave us a tailored
  // scenario, or left the LLM to follow the canonical arc. The system prompt
  // branches accordingly so we don't override a user's storyboard with the
  // canonical Plaid pitch arc.
  let storyboardTier = { tier: 'generic', signals: [], beatList: [], scenarioContext: null };
  try {
    const { extractPromptEntities, detectStoryboardTier } = require('./prompt-fidelity');
    const entities = extractPromptEntities(promptText);
    storyboardTier = detectStoryboardTier(promptText, { entities });
  } catch (_) { /* helper optional; fall back to canonical arc */ }

  let narrativeArcBlock;
  if (storyboardTier.tier === 'verbatim' && storyboardTier.beatList.length >= 3) {
    // Tier 1 — user wrote explicit beats. Map 1:1; do NOT reshape.
    narrativeArcBlock =
      `USER-PROVIDED STORYBOARD (preserve verbatim — non-negotiable):\n` +
      `The user wrote an explicit storyboard in their prompt (signals: ${storyboardTier.signals.join(', ')}). ` +
      `Treat each beat below as ground truth: map exactly one demo-script step per beat, in the same order. ` +
      `Do NOT reshape into the canonical arc. Do NOT add steps the user didn't list. Do NOT remove ` +
      `steps the user listed (unless the brief explicitly marks one as optional).\n\n` +
      `User's beats (${storyboardTier.beatList.length} total — step count = beat count, NOT 8-14):\n` +
      storyboardTier.beatList.map((b, i) => `  ${i + 1}. ${b}`).join('\n') +
      `\n\n` +
      `Quality standards still apply (active voice, banned words, persona realism, narration 20-35 words ` +
      `per step), but step count and step ordering are dictated by the user's list above.\n\n`;
  } else if (storyboardTier.tier === 'scenario-derived') {
    // Tier 2 — user gave us scenario context but no beats. Build a tailored
    // storyboard for THIS scenario; canonical arc is structural skeleton only.
    const ctx = storyboardTier.scenarioContext || {};
    const scenario = ctx.useCase || ctx.scenarioSentence || '(scenario context detected — see prompt body)';
    narrativeArcBlock =
      `SCENARIO-DERIVED STORYBOARD (build a tailored arc — DO NOT use a generic Plaid pitch):\n` +
      `The user described a specific scenario but did NOT write explicit beats. ` +
      `Your job: design a storyboard that demonstrates THIS scenario end-to-end, not a generic ` +
      `Plaid product showcase. The canonical arc below is a structural skeleton only — fill it ` +
      `with scenario-specific content.\n\n` +
      `User's scenario (treat as the spine of the narrative):\n` +
      `> ${scenario}\n\n` +
      `Canonical arc structure (apply to the user's scenario):\n` +
      `1. Problem — the friction the user described (do NOT invent a different problem)\n` +
      `2. Solution entry — Plaid enters AT the moment the user said it should\n` +
      `3. Product reveals — ONE dedicated insight step per Plaid product in the demo.\n` +
      `   Each step shows that product's specific API output and narrates the business implication.\n` +
      `   Never combine two product reveals into one step. Every product named in the prompt\n` +
      `   must appear as a distinct step with its own apiResponse block.\n` +
      `   The slide/apiResponse SHOWS the exact API output (account/routing, per-field scores like\n` +
      `   NAME 88 / EMAIL 62, Signal score + ruleset.result); the NARRATION speaks to the implication\n` +
      `   (ownership confirmed, low-risk → ACCEPT) — directionally, never reading the raw numbers aloud.\n` +
      `4. Key reveal — the wow moment that resolves the user's specific friction, stated as the OUTCOME\n` +
      `   (the decision/result — ACCEPT, approved, verified, qualifies, low-risk), not the raw on-screen value\n` +
      `5. Outcome — close with a concrete business result tied to this demo's opening problem.\n` +
      `   Format: "[Product(s)] deliver [outcome or capability] — enabling [customer outcome\n` +
      `   from the opening hook]." Must callback to beat 1. Do NOT close with a generic mantra\n` +
      `   ("faster, safer, more compliant") — use the scenario's specific numbers and stakes.\n\n` +
      `Quality standards:\n` +
      `- Step count by product count: 1 product → 6–9 steps; 2 products → 8–11 steps; 3+ products → 10–14 steps\n` +
      `- Narration: 20–35 words per step (including loading/wait steps — see rule below)\n` +
      `- Include a climactic reveal stated as an OUTCOME/decision (e.g. ACCEPT, approved, qualifies, low-risk) — not by reading the on-screen number\n` +
      `- Use realistic persona data (never generic placeholders)\n` +
      `- No error states, declined flows, or unresolved loading spinners\n\n`;
  } else {
    // Tier 3 — generic fallback. Today's behavior, kept as the safety net.
    narrativeArcBlock =
      `Narrative arc (always follow):\n` +
      `1. Problem — friction or compliance challenge specific to this demo's scenario\n` +
      `2. Solution entry — Plaid introduced as the answer\n` +
      `3. Product reveals — ONE dedicated insight step per Plaid product in the demo.\n` +
      `   Each step shows that product's specific API output and narrates the business implication.\n` +
      `   Never combine two product reveals into one step. Every product named in the prompt\n` +
      `   must appear as a distinct step with its own apiResponse block.\n` +
      `   The slide/apiResponse SHOWS the exact API output (account/routing, per-field scores like\n` +
      `   NAME 88 / EMAIL 62, Signal score + ruleset.result); the NARRATION speaks to the implication\n` +
      `   (ownership confirmed, low-risk → ACCEPT) — directionally, never reading the raw numbers aloud.\n` +
      `4. Key reveal — the "wow moment" (approval, matched ownership, cleared decision) stated as the OUTCOME,\n` +
      `   not by reading the raw on-screen number (say "low-risk → ACCEPT", not "Signal score 12")\n` +
      `5. Outcome — close with a concrete business result tied to the opening problem.\n` +
      `   Format: "[Product(s)] deliver [outcome or capability] — enabling [customer outcome\n` +
      `   from beat 1]." Must callback to the problem in beat 1. Do NOT close with a generic mantra\n` +
      `   ("faster, safer, more compliant") — use the scenario's specific numbers and stakes.\n\n` +
      `Quality standards:\n` +
      `- Step count by product count: 1 product → 6–9 steps; 2 products → 8–11 steps; 3+ products → 10–14 steps\n` +
      `- Narration: 20–35 words per step (including loading/wait steps — see rule below)\n` +
      `- Include a climactic reveal stated as an OUTCOME/decision (e.g. ACCEPT, approved, qualifies, low-risk) — not by reading the on-screen number\n` +
      `- Use realistic persona data (never generic placeholders)\n` +
      `- No error states, declined flows, or unresolved loading spinners\n\n`;
  }

  const system =
    `You are a senior Plaid demo designer with deep knowledge of Plaid's product ` +
    `portfolio and brand voice. You produce demo scripts that convert prospects and train sales teams.\n\n` +
    `Brand voice rules (non-negotiable):\n` +
    `- Confident, precise, outcome-focused. Never apologetic or jargon-heavy.\n` +
    `- Lead with customer value, not technical implementation details.\n` +
    `- Use active voice: "Plaid verifies the document in real time" not "the document is verified."\n` +
    `- NARRATE OUTCOMES, DON'T READ THE SCREEN. Speak to what a result MEANS for the user/business —\n` +
    `  its direction and decision — never recite the exact on-screen number. The slide/API panel SHOWS\n` +
    `  the precise values (dollar amounts, scores, account masks); the voiceover stays high-level + natural.\n` +
    `    • Income/cashflow: "her verified income easily clears the loan threshold" — NOT "bi-weekly income of $2,236".\n` +
    `    • Signal/risk score: "a low-risk transaction — the lower the score, the safer the ACH" and the decision\n` +
    `      ("cleared to ACCEPT") — NOT "Signal score 12". Directional high-vs-low meaning is encouraged; the raw value is not.\n` +
    `    • Linked account: "her checking account — Gold Savings — is connected" — NOT "account ending 4821".\n` +
    `    • Identity/match: "name and email confirmed as a strong ownership match" — NOT "NAME 88 / EMAIL 62".\n` +
    `  Decisions/results ARE fine to say out loud (ACCEPT / REVIEW / approved / verified / qualifies). Apply to ALL metrics.\n` +
    `- MATCH THE SCREEN. Any specific NAME you say in narration (account/plan/card name, institution,\n` +
    `  decision label) MUST appear in that step's on-screen content — put it verbatim in the step's\n` +
    `  visualState and/or apiResponse. Never narrate a name that isn't rendered. For the bank account\n` +
    `  linked via Plaid Link, use the label the live sandbox actually shows (e.g. "Plaid Checking",\n` +
    `  "Plaid Saving") — do NOT invent a marketing name like "Gold Savings" that won't be on screen.\n` +
    `- Never use: "simply", "just", "unfortunately", "robust", "seamless".\n` +
    `- Use only approved product names: "Plaid Identity Verification (IDV)", "Plaid Instant Auth", ` +
    `"Plaid Layer", "Plaid Monitor", "Plaid Signal", "Plaid Assets".\n\n` +
    narrativeArcBlock +
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
        (embeddedLinkMode === 'embedded'
          ? `Use modal pre-Link UX patterns only where they do NOT conflict with the embedded Link skill above. ` +
            `In embedded mode: do NOT duplicate the SDK "Recommended" tile in the host trust column; ` +
            `the live embed owns instant verification. Manual path = subtle "Connect manually" link only.\n\n`
          : `Use this specifically for pre-Link and pre-Plaid UX composition, copy hierarchy, CTA labels, and security/value framing.`),
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

  // Host-company context LAST + lowest authority: it follows all the authoritative
  // material (prompt, curated product knowledge, internal Glean/AskBill research) so
  // the model treats it as supplementary and yields to the prompt + research on conflict.
  if (hostCompanyContextBlock) {
    contentBlocks.push({
      type: 'text',
      text: hostCompanyContextBlock,
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
        // When the orchestrator is running in app+slides mode (--with-slides set),
        // strip prompt-level "no slides" directives so the script generator obeys
        // the orchestrator's slide intent rather than a stale "NO-SLIDE REQUIREMENT"
        // section the operator forgot to remove. The model gets conflicting signal
        // otherwise and the prompt-level instruction always wins (more specific).
        // App-only runs leave these directives in place.
        if (!pipelineAppOnlyHostUi) {
          content = stripPromptLevelNoSlidesDirectives(content);
        }
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
      `      "narration": "<20–35 words, active voice, OUTCOME/directional (never read exact on-screen $/scores/account masks) — ALL steps including loading/wait states>",\n` +
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
      `LOADING / WAIT STEP NARRATION RULE:\n` +
      `Steps showing progress spinners or async wait states (report-generating, verifying, processing)\n` +
      `must narrate WHAT Plaid is doing under the hood — not just that it is doing it.\n` +
      `Target 18–25 words explaining the data pull, analysis, or scoring happening off-screen.\n` +
      `Good: "Plaid pulls 24 months of cash-flow data — income deposits, recurring bills, payroll\n` +
      `timing — and scores repayment likelihood in real time." (24 words)\n` +
      `Bad: "The CRA base report generates." (6 words — tells the viewer nothing)\n\n` +
      `CLOSING STEP CALLBACK RULE:\n` +
      `The final non-slide step (or value-summary-slide narration) must tie back to the specific\n` +
      `problem stated in step 1. Format: "[Product(s)] deliver [metric] — enabling [outcome from\n` +
      `opening hook]." Generic mantras ("faster, safer, more compliant") without scenario-specific\n` +
      `numbers are not acceptable as a closing beat.\n\n` +
      `NARRATION FLOW RULE (scene-to-scene continuity — read narrations as ONE script):\n` +
      `The narration track is heard as one continuous voiceover, so write it as one story, not\n` +
      `eleven isolated captions. Before finalizing, read all narrations in sequence aloud:\n` +
      `- CONNECT EVERY SCENE CHANGE. Default: every step after the first opens with connective\n` +
      `  tissue that carries the previous beat's outcome forward. A cold open is allowed only when\n` +
      `  deliberate — the opening step, or a hard act break where a reset sharpens the story.\n` +
      `  YOU choose the connective phrasing — creative freedom is expected. Vary the form:\n` +
      `    temporal   ("Once…", "Now that…", "With identity settled…")\n` +
      `    causal     ("That score clears the way for…", "That session returns…")\n` +
      `    spatial    ("Back in the app…", "Inside the underwriter's view…")\n` +
      `    revelation ("Behind that confirmation…", "Behind that single consent…")\n` +
      `- BEHIND-THE-SCENES handoff (the prime transition site): when the next step is an API\n` +
      `  insight beat, bridge from the on-screen outcome the viewer just watched into the\n` +
      `  off-screen API work. Model (adapt freely, never reuse verbatim across steps):\n` +
      `  "Once Plaid Link has authenticated the bank account successfully, behind the scenes\n` +
      `  the /auth/get API returns verified routing and account numbers in one call."\n` +
      `  Endpoint names belong only in these insight-step transitions — never in host-step narration.\n` +
      `- GOOD transitions (from real shipped scripts):\n` +
      `  ✓ "That session returns a verdict straight from Plaid's identity check — status success…"\n` +
      `  ✓ "With identity settled, one question remains: can he repay?…"\n` +
      `  ✓ "Behind that single consent, Bank Income detects a regular income stream…"\n` +
      `- BAD cold starts (real failures — do not do this):\n` +
      `  ✗ "The lender writes the identity to the user record…" (backend jump with no bridge from\n` +
      `    the session the viewer just watched)\n` +
      `  ✗ "The report-ready webhook fires —…" (developer jargon as an opener, zero connective tissue)\n` +
      `- The transition lives INSIDE the 20–35 word budget: a short connective clause (3–8 words),\n` +
      `  then the step's own content. Do not pad a narration to fit a transition in.\n` +
      `- Plaid Link boundary (updated): the launch step OPENS with a short bridge that introduces the\n` +
      `  Plaid Link experience — name the ACTUAL on-screen button and that it brings up Plaid Link —\n` +
      `  to cover the ~2-3s modal load (otherwise the narration ends before the modal renders). Then\n` +
      `  describe what's inside. e.g. "Joe taps Link bank account, bringing up the Plaid Link experience…".\n` +
      `  The step AFTER a Link/IDV/Layer session is the prime transition site ("Once Plaid Link has\n` +
      `  authenticated…", "That session returns…").\n` +
      `- VARY sentence openers: never start two consecutive narrations with the same word, the\n` +
      `  same connective form, the persona's name, or "Plaid". Use the persona's first name in at\n` +
      `  most 3 narrations total — pronouns and role words ("she", "the owner", "the applicant")\n` +
      `  carry the rest.\n` +
      `- NO TEMPLATE STAMPING: do not reuse the same sentence skeleton ("X does Y — Z happens")\n` +
      `  across steps. Alternate rhythm: a short punchy line (8-12 words) after every 2-3 longer ones.\n` +
      `- HAND OFF forward: when a beat sets up the next screen, let the last clause lean into it\n` +
      `  ("…and the report starts building." → next beat opens on the report). The pre-Link tap rule\n` +
      `  ("…taps Connect your bank.") is the model — apply the same momentum elsewhere.\n` +
      `- SOUND SPOKEN, not written: contractions are good ("it's", "that's"); apposition-heavy\n` +
      `  marketing constructions ("Plaid, the network powering…") are not. If a sentence would feel\n` +
      `  stiff said across a desk to a prospect, rewrite it.\n\n` +
      `PLAID SESSION STEP RULE (CRITICAL — non-negotiable):\n` +
      `A demo may include ONE OR MORE live Plaid sessions. Each DISTINCT Plaid session is its\n` +
      `own single step with "plaidPhase":"launch" and sceneType:"link". The distinct sessions are:\n` +
      `  • Plaid Layer (network prefill onboarding)\n` +
      `  • Identity Verification / IDV (document + selfie KYC)\n` +
      `  • Plaid CRA / Consumer Report (cra_base_report / income_insights)\n` +
      `  • Plaid Link bank connection (auth / identity / balance / transactions / signal / transfer)\n` +
      `Rules:\n` +
      `- Use EXACTLY ONE step PER session. Do NOT split a session into separate consent, OTP,\n` +
      `  institution-selection, account-selection, or success sub-steps — the recording automation\n` +
      `  handles those internally via CDP iframe automation.\n` +
      `- When a flow legitimately CHAINS sessions (e.g. Layer → Identity Verification → bank Link,\n` +
      `  or Identity Verification → bank Link), emit one launch step PER session, in flow order.\n` +
      `  Do NOT fake one session as a static host screen, and do NOT merge two different products\n` +
      `  into a single launch step.\n` +
      `- TOKEN mutual-exclusivity still holds: Identity Verification is its OWN Link token\n` +
      `  (products:["identity_verification"]) — never combine it with auth/identity/etc. in the\n` +
      `  same token; it appears as a SEPARATE launch step alongside the bank Link launch.\n` +
      `- Do NOT create a standalone pre-Link explainer step before a launch; merge trust/value copy\n` +
      `  into the launch step itself.\n` +
      `- Each launch step's narration (up to ~45 words — launch steps get extra room to cover the\n` +
      `  modal load) OPENS by introducing the Plaid Link experience — naming the actual on-screen button\n` +
      `  (must match the rendered CTA) and that it brings up Plaid Link — to cover the ~2-3s modal-load\n` +
      `  beat, THEN conveys the OUTCOME of the connection. Do NOT enumerate every sub-step (institution\n` +
      `  pick → account select → success screen) like a checklist — the recording shows those; keep it\n` +
      `  natural. e.g. "Joe taps Link bank account, bringing up Plaid Link, and connects his bank in seconds."\n` +
      `- For a phone-number + one-time-passcode (returning-user / Remember-Me) launch, you MUST weave in\n` +
      `  the Plaid-network framing — it explains WHY the user is recognized and fills the verification\n` +
      `  beat — INSTEAD of narrating each sub-step. Directionally, e.g. "Joe taps Continue with Plaid,\n` +
      `  opening the Plaid Link experience. Recognized as a returning user on the Plaid network — where\n` +
      `  roughly one in two U.S. adults have connected a bank with Plaid Link — he confirms a one-time\n` +
      `  code and his accounts connect." Vary the wording; this framing is required for phone+OTP launches.\n\n` +
      `SCENE METADATA RULE (CRITICAL):\n` +
      `Set sceneType for every step and keep it consistent with structure:\n` +
      `- host: customer-branded host UI step\n` +
      `- link: a Plaid session launch step (must also have plaidPhase:"launch"); a demo may have one per distinct session (Layer / IDV / CRA / bank Link)\n` +
      `- insight: Plaid insight step using global api-response-panel; optional deck-style layout may use .slide-root shell (see build prompt) but never host UI\n` +
      `- slide: template-driven slide step that uses .slide-root\n` +
      `Do not label insight steps as slide unless they intentionally render .slide-root.\n\n` +
      `SLIDE ROLE RULE (drives template selection):\n` +
      `For every sceneType:"slide" (and any insight step rendered as .slide-root), set "slideRole" to the\n` +
      `narrative job the slide performs. The router maps the role to the right Plaid template, so prefer\n` +
      `slideRole over slideTemplate/workhorseLayout (leave those unset unless you must pin a specific template).\n` +
      `Pick the single best-fit role:\n` +
      `- opening (deck title/hero) · section-break (chapter divider) · value-summary (the closing outcomes slide)\n` +
      `- problem-statement (one headline + one idea) · concept-explainer (3–6 peer bullets) · three-pillars (exactly 3 peers) · pull-quote\n` +
      `- hero-metrics (≤3 big numbers) · kpi-dashboard (4 metrics w/ deltas) · api-field-reveal (KEY FIELDS AN API RETURNS + their sample values) · data-comparison-table (pricing/threshold rows) · bar-chart\n` +
      `- before-after (old vs new) · transformation-rows · sequential-steps (numbered process) · flow-diagram · architecture · timeline · roadmap\n` +
      `- code-proof (one API call/snippet) · customer-proof (testimonial + stat)\n` +
      `Use api-field-reveal — NOT kpi-dashboard/hero-metrics — when the slide shows the fields an API response\n` +
      `returns alongside sample values (e.g. CRA Income Insights / Cash Flow Insights / Base Report read-outs).\n\n` +
      `HOST VS SLIDE — ZERO COMPONENT CROSS-REUSE (CRITICAL):\n` +
      `Do not describe or require host demo UI (nav, banners, account cards, dashboard modules) inside slide visualState or slide copy — slides are Plaid-only deck surfaces.\n` +
      `Do not describe or require slide deck shell (.slide-root regions, slide header/footer strips, slide panel grid) inside host, link, or insight visualState.\n` +
      `Narrative may echo themes; DOM/layout systems must stay separate except the shared global #api-response-panel on insight/slide per pipeline contract.\n\n` +
      `API PANEL IN visualState (CRITICAL):\n` +
      `The global #api-response-panel is a fixed overlay that stays COLLAPSED by default on every step — the presenter expands it live. ` +
      `NEVER write visualState text that requires the panel "expanded", "open", "visible", or "showing JSON". ` +
      `Instead describe the step's concrete API values (scores, statuses, amounts, field values) as styled in-slide content (cards, key/value rows, metric chips). ` +
      `Also never prescribe a slide background color in visualState (navy vs light/cream/holo) — the deck design system owns background rhythm.\n\n` +
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
          `and a closing declarative outcome line), never a blank placeholder surface.\n` +
          `Do NOT require a CTA button in visualState — sales CTAs (buttons, pill CTAs, "contact us" /\n` +
          `"get started" actions) are forbidden on slides; the value summary closes with outcome bullets\n` +
          `+ declarative copy only.\n\n`
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

  if (embeddedLinkMode === 'embedded') {
    contentBlocks.push({
      type: 'text',
      text:
        `## EMBEDDED LINK SCRIPT RULE (mode-specific — overrides modal pre-Link patterns)\n\n` +
        `When plaidLinkMode is "embedded":\n` +
        `- Exactly ONE step with sceneType:"link" and plaidPhase:"launch" — the integrated pre-link page.\n` +
        `- That step combines host trust copy (headline, encryption bullets, consent) AND the live embedded widget.\n` +
        `- Do NOT create a separate host pre-link step before a bare plaid-link-launch step.\n` +
        `- Do NOT describe a host-side "Recommended · Instant verification" tile — the Plaid SDK shows that inside the embed.\n` +
        `- Manual verification is a subtle "Connect manually" link only (not a competing primary card).\n` +
        `- Launch step interaction: goToStep → launch step id, waitMs: 120000 (no link-external-account-btn click).\n`,
    });
  }

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
  // JSON/API panels axis. When disabled (--no-panels), the post-panels stage is
  // skipped, so the build agent must NOT author any #api-response-panel chrome
  // or the placeholder — otherwise the no-panels app ships an empty panel shell.
  const withPanels = opts.withPanels != null
    ? opts.withPanels !== false
    : String(process.env.PIPELINE_WITH_PANELS || '').trim().toLowerCase() !== 'false';
  const sidePanelInstruction = withPanels
    ? `- Side panels — do NOT hand-author these. The post-panels stage owns the\n` +
      `  canonical Claude Design v12 API panel (section.panel + Request/Response tabs +\n` +
      `  renderjson pretty-printer) and injects it into the HTML after build. Just leave\n` +
      `  this placeholder before </body> and post-panels will fill it in:\n` +
      `    <!-- API_PANEL_AND_LINK_EVENTS — injected by post-panels post-build -->\n` +
      `  If you absolutely must reference panel IDs from your JS, the v12 stable IDs are:\n` +
      `    #api-response-panel (the wrapping section), #api-panel-method, #api-panel-path,\n` +
      `    #api-pane-request, #api-pane-response, #api-panel-toggle. Do NOT use the legacy\n` +
      `    .side-panel / .side-panel-header / .side-panel-body / .api-panel-edge-toggle /\n` +
      `    #api-response-content / #api-panel-endpoint — those were removed.\n` +
      `  link-events-panel: developer artifact — NEVER shown in any step. Always display:none.\n`
    : `- JSON/API PANELS DISABLED (--no-panels): do NOT author ANY API/JSON side panel.\n` +
      `  Emit NO #api-response-panel section, no JSON rail, no api-panel-* elements, no\n` +
      `  api-panel config constant, and NOT the <!-- API_PANEL_AND_LINK_EVENTS --> placeholder.\n` +
      `  Insight/host steps present their content WITHOUT any raw-JSON side panel (no inline\n` +
      `  JSON blocks either). Do not reference #api-response-panel from JS.\n` +
      `  link-events-panel: still NEVER shown — display:none if present at all.\n`;
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
  // Real Plaid Layer via the Web SDK (NOT the mobile mock): when the demo is a Layer
  // flow with a real launch step and we are not in mobile-mock mode. The generated app
  // uses Plaid.create + handler.open()/submit() against /api/create-session-token rather
  // than hand-built simulated Layer screens. See plaid-layer-idv-onboarding skill.
  const useRealLayerWebSdk = (() => {
    if (useLayerMobileMockTemplate) return false;
    const product = String(demoScript?.product || '').toLowerCase();
    const flow = String(demoScript?.plaidSandboxConfig?.plaidLinkFlow || '').toLowerCase();
    const hasLaunch = Array.isArray(demoScript?.steps) &&
      demoScript.steps.some((s) => String((s && s.plaidPhase) || '').toLowerCase() === 'launch');
    const layerSignaled = product.includes('layer') || flow === 'layer' || flow === 'layer-web-sdk';
    return layerSignaled && hasLaunch;
  })();
  // Identity Verification (IDV) launch steps. A demo may have MULTIPLE
  // plaidPhase:"launch" steps (multi-launch contract: e.g. a real IDV session
  // AND a separate real bank Link session). The IDV launch needs DIFFERENT
  // wiring than a bank Link launch — its own token endpoint
  // (/api/create-idv-link-token, products:["identity_verification"] only),
  // its own CTA testid, and its own completion flag (_idvComplete). The Layer
  // block above only fires for Layer demos, so IDV-without-Layer launches
  // (Gringo / Debit / Censiq) would otherwise get no real-launch instruction.
  const idvLaunchSteps = (() => {
    if (!Array.isArray(demoScript?.steps)) return [];
    const inferLaunchProductLocal = (step) => {
      const text = [step?.launchProduct, step?.id, step?.label, step?.visualState, step?.narration]
        .filter(Boolean).join(' ').toLowerCase();
      if (/\blayer\b/.test(text)) return 'layer';
      if (/\bidv\b|identity[\s-]?verification/.test(text)) return 'idv';
      if (/\bcra\b|consumer[\s-]?report|income[\s-]?insights|base[\s-]?report|check[\s-]?report/.test(text)) return 'cra';
      return 'link';
    };
    return demoScript.steps.filter(
      (s) => s && String(s.plaidPhase || '').toLowerCase() === 'launch' && inferLaunchProductLocal(s) === 'idv'
    );
  })();
  const hasIdvLaunch = idvLaunchSteps.length > 0;
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
        `- **ZERO COMPONENT CROSS-REUSE (hard rule):** Do not embed host demo UI (nav, banners, account/overview cards, transfer chrome, host data-testid blocks) inside \`.slide-root\`. Do not put host/link flows inside slide shells. **Plaid insight** steps may reuse the **pipeline slide shell regions** (\`.slide-root\`, \`.slide-header\`, \`.slide-body\`, \`.slide-footer\` from pipeline-slide-shell.html) for deck-style API reveals—especially Plaid Signal / ACH return risk (\`/signal/evaluate\`): use a scoped modifier on \`.slide-root\` (e.g. \`slide-root--signal-insight\`). Give header/footer testids a **step-unique suffix** (e.g. \`-signal-risk\`) so they never duplicate \`value-summary-slide\` testids. Raw JSON only in \`#api-response-panel\`. JSON panel is a fixed overlay (z-index 2100) — slides and host steps must NOT reserve space for it.\n` +
        `- **SLIDE FULL-SCREEN ISOLATION (hard rule):** Wrap ALL host-only chrome in elements with class \`host-app-chrome\` — this includes the FDIC bar, top nav, sub-nav, footer, any left/right sidebar, AND any **step/progress tracker or indicator** (a stepper, progress bar, or "Send → Verify → … → Sent" breadcrumb the host app shows across the top). If (and ONLY if) this build uses such a tracker, implement it as ONE reusable host-chrome component and give its ROOT element the \`host-app-chrome\` class so it is automatically hidden whenever a slide step is active — a tracker is host chrome, never slide content, and must NEVER bleed onto a full-bleed slide (observed: a \`.progress\` stepper strip showing on the value-summary slide). Slide steps (\`.slide-root\` inside \`data-testid="step-*"\`) must NEVER show host chrome — post-panels toggles \`body.pipeline-slide-active\` to hide \`.host-app-chrome\` and reset the canvas to Plaid navy. Do NOT nest slides inside \`.page-inner\`, sidebars, or host cards.\n` +
        `- Host global CSS (\`html, body, h1–h4\`) uses customer tokens ONLY. Slide typography/colors come from \`.slide-root\` + pipeline-slide-contract.css — never inherit Huntington serif or host hex inside slides.\n` +
        `- The slide CSS above applies ONLY inside a step div that contains \`.slide-root\` (marketing \`sceneType:slide\` steps **or** Plaid insight steps that adopt the shell).\n` +
        `- Do NOT restyle \`html\` or \`body\` using slide tokens. The HOST BANK UI (nav, cards, TD/chrome, consumer screens, Plaid Link host page) MUST follow the HOST APP DESIGN SYSTEM block only.\n` +
        `- Full-viewport Plaid insight steps: use **either** legacy \`insight-screen\` + \`insight-content\` **or** the slide shell pattern above for Signal-style evaluations; never host chrome. \`sceneType\` in demo-script stays \`insight\` when using the shell for API steps.\n` +
        `- Slides exist only to explain behind-the-scenes API/data; they are Plaid-styled; the rest of the app is customer-branded.\n` +
        `- For API endpoint storytelling slides/insights, keep one raw JSON mechanism only: global \`#api-response-panel\`. Never render duplicate inline raw JSON containers in \`.slide-root\`.\n` +
        `- JSON panel eligibility is endpoint-driven: only steps with explicit \`apiResponse.endpoint\` may use/show JSON panel behavior.\n` +
        `- **\`_stepApiResponses\` entry shape (HARD)**: every step entry MUST be \`{ endpoint: "<METHOD /path>", data: <object> }\` — the host JS reads \`apiData.endpoint\` for the panel label and \`apiData.data\` for the body. Emitting raw response data as the top-level value (i.e. without the \`endpoint\` / \`data\` wrapper) makes the header render "Plaid API Response: undefined". Use the wrapped shape uniformly across every step that has a JSON panel.\n` +
        `- **\`endpoint\` field MUST be populated** with the actual Plaid endpoint string (e.g. \`"POST /auth/get"\`, \`"POST /transfer/authorization/create"\`, \`"Plaid Link onSuccess → POST /item/public_token/exchange"\`). Never leave it blank, \`null\`, or \`undefined\` — the panel will surface the literal string in the header.\n` +
        `- **\`data\` field MUST be a realistic example response body** for that endpoint, matching the documented Plaid API response shape (real field names, sandbox-grade values, request_id, etc.). For Auth: \`accounts[]\` + \`numbers.ach[]\`. For Identity Match: per-field \`score\` 0–100. For Transfer authorization: \`authorization.{id, decision, decision_rationale, proposed_transfer}\`. Never use \`{ status: "ok" }\` placeholders or partial payloads.\n` +
        `- If a step has \`apiResponse\`, keep the side panel collapsed/hidden by default on initial page load.\n` +
        `- Include one JSON panel edge toggle control: \`data-testid="api-panel-toggle"\` with \`window.toggleApiPanel()\` (no Show/Hide JSON buttons).\n` +
        `- When panel is shown, render JSON fully expanded via renderjson (\`set_show_to_level('all')\` or equivalent).\n` +
        `- Add a global API panel config constant for runtime behavior (collapsed-by-default, expanded JSON level, auto-resize guardrails).\n` +
        `- Use the presentation slide template/rules for JSON panel visual styling; do not invent ad-hoc JSON panel styles.\n` +
        `- Slide content must summarize only high-signal attributes (3-6 bullets) that support the story decision; raw payload remains in global panel.\n` +
        `- API request/response shown in panel must match the slide's claim and endpoint context (no mismatched endpoint narrative).\n` +
        `- **Slide surface:** keep \`.slide-root\` **responsive** per PIPELINE_SLIDE_SHELL_RULES / slide template contract (fluid width/height capped at 1440×900, \`aspect-ratio: 16/10\`). Do not set fixed \`width:1440px;height:900px\` on \`.slide-root\`.\n` +
        `- **Plaid chrome logo (HARD):** On slides, never fabricate the Plaid mark. Use only \`<img class="chrome-logo" src="assets/logos/plaid-horizontal-*.png">\` from the bundled logo library, or omit the logo. No inline SVG, icon grids, or "PLAID" text labels. **Placement:** top-right via CSS only (\`top: calc(var(--pad-top) - 75px); right: var(--pad-x); height: 28px\`) — never inline \`left:\` or showcase-scale \`height:\`.\n\n`
      : '') +
    (!includeFullSlideTemplate
      ? `SLIDE TRACK (minimal contract — slide insertion is deferred to post-slides stage):\n` +
        `- Do not spend tokens on full slide-shell polish in this pass.\n` +
        `- Preserve canonical step wrappers and ordering from demo-script.json.\n` +
        `- For sceneType:"slide" (or stepKind:"slide") steps, emit ONLY the canonical placeholder shape below.\n` +
        `  Do NOT emit \`.slide-root\`, \`.frame\`, \`.chrome-logo\`, or any slide visual chrome — those are produced\n` +
        `  by the post-slides stage, which has full slide template context. A placeholder here is a \\
contract that the next stage knows how to fill.\n` +
        `\n` +
        `  CANONICAL SLIDE PLACEHOLDER (emit verbatim per slide step; substitute {id}, {label}, {T#}):\n` +
        `    <div data-testid="step-{id}" class="step">\n` +
        `      <div class="slide-pending-host" data-slide-pending="true" data-slide-template="{T#}">\n` +
        `        <p style="font-size:24px">Slide placeholder &middot; {label} &middot; awaiting post-slides.</p>\n` +
        `      </div>\n` +
        `    </div>\n` +
        `\n` +
        `  Template selection: use the step's \`slideTemplate\` field if present (T1-T11); otherwise default to T1.\n` +
        `- Do not create duplicate step IDs/testids; keep all existing interaction selectors stable.\n` +
        `- Keep global API panel wiring valid; no inline raw JSON panels in steps.\n` +
        (deferredSlidesTrack
          ? `- A slides follow-up phase will upgrade slide visuals; prioritize host-app richness now.\n\n`
          : '\n')
      : '') +
    (includeFullSlideTemplate
      ? `Slide steps are filled by post-slides using templates from templates/slide-template/showcase/index.html (20 Workhorse layouts). Do NOT embed pipeline-slide-shell.html as the slide layout default.\n\n`
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
    `- NO AUTO-ADVANCE (HARD): a step must NEVER auto-advance to another step via setTimeout / setInterval / requestAnimationFrame calling goToStep. Every transition is driven ONLY by explicit user action (button click, keyboard nav) or by goToStep invoked externally (QA/recorder). "Loading" / "processing" / "verifying" / "generating report" screens must be the resting state of their OWN step (show a spinner/progress bar that stays) — do NOT schedule a timer that moves to the next step. Auto-advancing makes the expected step inactive at capture time → build-qa "navigation-mismatch" deterministic failure.\n` +
    `- Manual navigation (REQUIRED — add immediately after goToStep/getCurrentStep definitions):\n` +
    `    ArrowRight/ArrowDown = next step. ArrowLeft/ArrowUp = previous step.\n` +
    `    Clicking any non-interactive area of a step also advances to the next step.\n` +
    `    Clicks on button, input, select, textarea, a, [role="button"]/[role="link"] pass through.\n` +
    `    Use this exact implementation (do not alter):\n` +
    `    (function(){\n` +
    `      function _sids(){return Array.from(document.querySelectorAll('.step[data-testid]')).map(function(s){return s.dataset.testid.replace(/^step-/,'');});}\n` +
    `      function _nav(d){var ids=_sids(),cur=(window.getCurrentStep()||'').replace(/^step-/,''),idx=ids.indexOf(cur),n=ids[Math.max(0,Math.min(ids.length-1,idx+d))];if(n&&n!==cur)window.goToStep(n);}\n` +
    `      document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='ArrowDown')_nav(1);else if(e.key==='ArrowLeft'||e.key==='ArrowUp')_nav(-1);});\n` +
    `      document.addEventListener('click',function(e){if(e.target.closest('button,input,select,textarea,a,[role="button"],[role="link"]'))return;if(e.target.closest('.panel,.toggle,.card[onclick*="goToStep"]'))return;_nav(1);});\n` +
    `    })();\n` +
    sidePanelInstruction +
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
    `    - DO NOT hand-author the panel chrome, toggle, or renderjson glue. The post-panels stage owns ALL of it:\n` +
    `      it emits the Claude Design v12 markup (section.panel + .panel-head + .tabs + .panel-toolbar +\n` +
    `      .code-wrap with pre.code[data-pane="req|res"]), injects the renderjson pretty-printer shim\n` +
    `      (fully expanded by default), wires the Request/Response tab toggle, and binds the chevron.\n` +
    `    - YOUR ONLY JOB on the host page is to provide the per-step DATA so post-panels can hydrate the panel:\n` +
    `      populate \`window._stepApiResponses[stepId] = { endpoint, request, response }\` (wrapped shape).\n` +
    `      \`endpoint\` is a string like "POST /auth/get". \`request\` is the JSON request body the host would send\n` +
    `      (set to \`null\` for browser-only callbacks like Plaid Link onSuccess). \`response\` is the JSON response body.\n` +
    `    - Default UX: panel arrives collapsed; only the chevron is visible at the viewport right edge.\n` +
    `    - The pre-existing \`window.populateApiPanel(endpoint, payload)\` (set up by post-panels) is\n` +
    `      called automatically by the wrapped goToStep — do not call it yourself.\n` +
    `    - Renderjson and its CDN <script> tag are loaded by post-panels — do NOT add either yourself.\n` +
    `      The shim replaces window.renderjson with a fully-expanded pretty-printer; no set_show_to_level call needed.\n` +
    `    - DO NOT style \`.disclosure\` with width/height/background. The renderjson library's "+/-" toggles\n` +
    `      must remain inline text characters — post-panels CSS already pins this. Any rule containing\n` +
    `      'width:', 'height:', 'background:', 'background-color:', or 'background-image:' on a .disclosure\n` +
    `      selector will be flagged by build-qa as a deterministic blocker.\n` +
    `    - Default visual: panel slides off-screen to the right when collapsed; chevron flips 180° on collapse.\n` +
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

  if (productFamily === 'cra_lend_score') {
    contentBlocks.push({
      type: 'text',
      text:
        `## CRA LENDSCORE HOST + API PANEL (HARD)\n\n` +
        `- Hero host step (e.g. lendscore-reveal): white/light ${brand?.name || 'host'} chrome — NOT Plaid deck slides.\n` +
        `- Show LendScore score (1–99, higher = safer), APPROVE (or review) outcome, **LendScore — beta** badge, 2–3 **reason_codes** chips (PCS-prefixed).\n` +
        `- \`apiResponse.endpoint\` MUST be \`POST /cra/check_report/lend_score/get\` with \`report.lend_score.score\` + \`reason_codes[]\` in JSON — even when Base Report summary chips appear beside the gauge.\n` +
        `- JSON panel is a fixed overlay (z-index 2100). Slides and host steps must NOT reserve right padding or max-width for #api-response-panel — it floats above content when expanded.\n` +
        `- Zip host footer on at least one screen: verbatim **NMLS ID 1963958** (see inputs/brand-references/zip.md).\n` +
        `- Host nav: customer checkout/underwriting labels only — **never** paste marketing mega-menu labels from brand-extract crawl.\n`,
    });
  }

  if (linkTokenCreate && opts.plaidLinkLive && includeLiveLinkInstructionBlock) {
    contentBlocks.push({
      type: 'text',
      text:
        `## LINK TOKEN CREATE (dynamic — research-driven)\n\n` +
        `The /link/token/create products[] list is **resolved by the research stage** ` +
        `(link-token-create-config.json) using prompt.txt + AskBill (Plaid docs MCP) + ` +
        `indexed product knowledge in inputs/products/, then sanitized against Plaid's ` +
        `product-mix rules (CRA vs non-CRA Income, income_verification compatibility).\n\n` +
        `**HARD RULE — do NOT hardcode a products[] array of your own choosing.** Use the ` +
        `EXACT body shown below for the /api/create-link-token fetch (replace <BrandName> ` +
        `with the host brand). The backend will additionally re-read the research config ` +
        `and override any drifted products[] at request time, so deviating here only ` +
        `creates a confusing mismatch between HTML and the wire request:\n\n` +
        `\`\`\`javascript\n` +
        `body: ${linkTokenFetchBodySnippet}\n` +
        `\`\`\`\n\n` +
        `Resolved object (for consistency with demo-script APIs):\n` +
        `${toJSON(linkTokenCreate)}\n`,
    });
  }

  contentBlocks.push({
    type: 'text',
    text:
      `## UPDATE MODE — "Reconnect bank" launches a REAL Plaid Link (connection repair)\n\n` +
      `If a beat depicts a lapsed bank connection (Item in ITEM_LOGIN_REQUIRED) with a "Reconnect" / ` +
      `"Repair connection" CTA, that CTA MUST relaunch Plaid Link in **update mode** with the real ` +
      `SDK — NOT a static host card or screenshot.\n` +
      `- Fetch the token from **POST /api/create-update-link-token** (no body needed — it is ` +
      `self-contained in sandbox: creates an Item, forces ITEM_LOGIN_REQUIRED, returns an ` +
      `update-mode link_token built from the existing access_token with NO products[]).\n` +
      `- Launch identically to the primary flow: \`Plaid.create({ token, onSuccess, onExit, onEvent }).open()\`.\n` +
      `- In onSuccess (update mode): mark the connection repaired and set window._plaidLinkComplete=true; ` +
      `**do NOT** call /api/exchange-public-token — the existing access_token stays valid (recovery = ` +
      `ITEM/LOGIN_REPAIRED). Re-auth in sandbox with user_good / pass_good.\n` +
      `- Keep the PRIMARY connection as the single plaidPhase:"launch" recorded step; the reconnect ` +
      `beat is a separate host-triggered launch. Full reference: inputs/plaid-link-sandbox.md §8.\n`,
  });

  contentBlocks.push({
    type: 'text',
    text:
      `## MULTI-ITEM LINK (CRA default) — onSuccess fires EMPTY\n\n` +
      `CRA / Consumer Report demos run in multi-item link mode (enable_multi_item_link:true, set by ` +
      `the backend) so one session can connect multiple institutions into a single Consumer Report. ` +
      `The client behavior differs: **onSuccess fires EMPTY (no public_token).** Wire completion ` +
      `defensively so the demo never stalls waiting for a token:\n` +
      `- In onSuccess (may be empty): set window._plaidLinkComplete=true and goToStep(<first post-link step>).\n` +
      `- ALSO in onEvent: if (eventName === 'HANDOFF') window._plaidLinkComplete=true; — multi-item ` +
      `onSuccess can be empty/late, HANDOFF is the reliable session-end signal.\n` +
      `- NEVER require a public_token to advance and do NOT call /api/exchange-public-token with an ` +
      `empty token. (Real token retrieval is server-side via SESSION_FINISHED / ITEM_ADD_RESULT — ` +
      `out of scope for the recorded happy path.) Reference: inputs/plaid-link-sandbox.md §9.\n`,
  });

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
  if (useRealLayerWebSdk) {
    contentBlocks.push({
      type: 'text',
      text:
        `## PLAID LAYER — REAL WEB SDK (NOT a mock)\n\n` +
        `This demo uses the **real Plaid Layer Web SDK**. Do NOT build simulated Layer screens ` +
        `(no \`layer-sign-up-instantly\` / \`layer-authenticate-device\` / \`layer-confirm-share\` ` +
        `bottom-sheet divs) and do NOT use a mobile-simulator shell. The real Layer modal renders ` +
        `itself; the host page only provides the onboarding entry and the post-Layer review screens. ` +
        `Source of truth: \`.claude/skills/plaid-layer-idv-onboarding/SKILL.md\`.\n\n` +
        `**Onboarding entry = mobile phone number ONLY (auto path — no user choice).**\n` +
        `- The launch step (\`"plaidPhase":"launch"\`) collects ONLY a mobile phone number, prefilled ` +
        `with the sandbox value, plus a single **"Continue"** button. That button IS the canonical ` +
        `launch CTA \`data-testid="link-external-account-btn"\` (normal-scale inline icon + label).\n` +
        `- Do **NOT** present an "Onboard with Plaid vs. continue manually" choice, a "Prefill with ` +
        `Plaid" button, or a separate "Continue manually" button. Whether the user gets Layer or a ` +
        `fallback is decided **automatically by Layer eligibility** (\`LAYER_READY\` → Layer proceeds; ` +
        `\`LAYER_NOT_AVAILABLE\`/\`LAYER_AUTOFILL_NOT_AVAILABLE\` → fallback). Never surface that branch.\n` +
        `- Wire the real SDK exactly in this order (open BEFORE submit — submit() postMessages into the ` +
        `iframe, which must exist first):\n` +
        '```javascript\n' +
        `function _formPhoneE164() {\n` +
        `  var el = document.querySelector('[data-testid="onboarding-phone-input"]');\n` +
        `  var p = ((el && el.value) || '+14155550011').replace(/[^\\d+]/g, '');\n` +
        `  if (!p.startsWith('+')) p = '+1' + p.replace(/^1/, '');\n` +
        `  return p; // E.164, normalized from the form value\n` +
        `}\n` +
        `// Event-driven state machine. Create the handler EARLY and run the\n` +
        `// eligibility check (submit phone) ON PAGE LOAD so LAYER_READY is ready\n` +
        `// before the user clicks Continue. The Continue CTA ONLY calls open()\n` +
        `// (idempotent, gated on LAYER_READY). open() is NEVER called before\n` +
        `// LAYER_READY (that errors "Please submit Phone Number before opening Link").\n` +
        `let _layerHandler = null, _layerReady = false, _layerOpenRequested = false, _layerHasOpened = false, _layerIneligible = false;\n` +
        `function _doLayerOpen() {\n` +
        `  if (_layerHasOpened || !_layerHandler) return;   // idempotent: one open() per attempt\n` +
        `  _layerHasOpened = true;\n` +
        `  _layerHandler.open();\n` +
        `}\n` +
        `async function initLayerEligibility() {   // call ON LOAD\n` +
        `  if (_layerHandler) return;              // one active handler per flow attempt\n` +
        `  const r = await fetch('/api/create-session-token', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client_user_id: window._clientUserId }) });\n` +
        `  if (!r.ok) { console.error('[create-session-token]', r.status); return; }\n` +
        `  const { link_token } = await r.json();\n` +
        `  _layerHandler = Plaid.create({\n` +
        `    token: link_token,\n` +
        `    onSuccess: async (public_token) => {\n` +
        `      // Frontend handoff only — backend is the source of truth. Exchange\n` +
        `      // immediately and persist identity + ALL items (items[] may be many).\n` +
        `      const s = await fetch('/api/user-account-session-get', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ public_token }) });\n` +
        `      const data = await s.json();\n` +
        `      window._layerIdentity = data.identity || null;   // SUBMITTED identity, not verified\n` +
        `      window._layerItems = data.items || [];            // many Items, not one\n` +
        `      window._layerRequestId = data.request_id || null; // persist for supportability\n` +
        `      window._plaidLinkComplete = true;\n` +
        `      window.goToStep('<first-post-layer-step-id>');\n` +
        `    },\n` +
        `    onEvent: (eventName) => {\n` +
        `      if (eventName === 'LAYER_READY') {\n` +
        `        _layerReady = true;\n` +
        `        if (_layerOpenRequested) _doLayerOpen();        // Continue already clicked → open now\n` +
        `      } else if (eventName === 'LAYER_NOT_AVAILABLE') {\n` +
        `        _layerHandler.submit({ date_of_birth: '1975-01-18' }); // Extended Autofill — SEPARATE submit\n` +
        `      } else if (eventName === 'LAYER_AUTOFILL_NOT_AVAILABLE') {\n` +
        `        _layerIneligible = true;\n` +
        `        try { _layerHandler.destroy(); } catch(_) {}\n` +
        `        window.goToStep('<manual-fallback-step-id>'); // use-case-specific fallback\n` +
        `      }\n` +
        `    },\n` +
        `    onExit: (err) => { console.warn('Layer exited', err); },\n` +
        `  });\n` +
        `  window._plaidHandler = _layerHandler;\n` +
        `  // Submit the FORM phone (never hardcode). A submit before the preload iframe\n` +
        `  // is ready is silently dropped and Plaid has no pre-submit ready event, so\n` +
        `  // retry until LAYER_READY/ineligibility resolves (guards keep it idempotent).\n` +
        `  let _t = 0; const _iv = setInterval(() => {\n` +
        `    if (_layerReady || _layerIneligible || _t >= 6) { clearInterval(_iv); return; }\n` +
        `    _t++; try { _layerHandler.submit({ phone_number: _formPhoneE164() }); } catch(_) {}\n` +
        `  }, 900);\n` +
        `}\n` +
        `function launchLayer() {   // Continue CTA — eligibility already ran on load\n` +
        `  if (_layerIneligible) { window.goToStep('<manual-fallback-step-id>'); return; }\n` +
        `  _layerOpenRequested = true;\n` +
        `  if (_layerReady) _doLayerOpen();\n` +
        `  else if (!_layerHandler) initLayerEligibility(); // safety net\n` +
        `}\n` +
        `// Run the eligibility check as soon as the page loads.\n` +
        `if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLayerEligibility);\n` +
        `else initLayerEligibility();\n` +
        '```\n' +
        `**Desktop Layer integration best practices (REQUIRED):**\n` +
        `1. Create the handler EARLY (as soon as you have the link_token) — on page load, not on the final CTA.\n` +
        `2. Run it as an event-driven state machine: create → submit(phone) → wait LAYER_READY → open() → onSuccess → backend \`/user_account/session/get\`.\n` +
        `3. Run the eligibility check ON LOAD so LAYER_READY is ready before the user clicks Continue; the Continue CTA only calls open().\n` +
        `4. One active handler per attempt — do not recreate handlers mid-flow.\n` +
        `5. Gate open() behind LAYER_READY ONLY — never open() right after create() or submit().\n` +
        `6. Idempotent event handling — guard with a \`hasOpened\` flag so duplicate LAYER_READY/rerenders don't open twice.\n` +
        `7. Separate phone and DOB submits — only submit({date_of_birth}) AFTER LAYER_NOT_AVAILABLE (Extended Autofill), never combined.\n` +
        `8. Normalize input before submit — phone to E.164, DOB as YYYY-MM-DD, trim whitespace.\n` +
        `9. Register listeners once — stable config, no duplicate onEvent attachment.\n` +
        `10. Backend is the source of truth — onSuccess is only the client handoff; exchange the public_token via \`/user_account/session/get\` promptly.\n` +
        `11. \`/user_account/session/get\` returns an **items[]** array — handle MANY Items, never \`items[0]\` only.\n` +
        `12. Treat returned identity as **submitted, not verified** (distinct from a downstream IDV verdict).\n` +
        `13. Persist \`request_id\` (and \`link_session_id\` when available) for supportability.\n` +
        `- **The form phone drives eligibility (REQUIRED):** the value in \`data-testid="onboarding-phone-input"\` ` +
        `MUST be read (normalized to E.164) and passed to \`handler.submit({ phone_number })\` — this is the ` +
        `Layer eligibility check (\`LAYER_READY\` / \`LAYER_NOT_AVAILABLE\`). Never submit a hardcoded number. ` +
        `Prefill the field with the eligible sandbox number. The Continue CTA onclick calls \`launchLayer()\`; ` +
        `set \`window._clientUserId\` once (stable non-PII id) and reuse it (Layer + IDV share it).\n` +
        `- Eligible sandbox phone is **+14155550011** (LAYER_READY — full identity + 2 linked banks); ` +
        `OTP 123456. Do NOT use 415-555-1111 (that is the mock convention, not real Layer).\n` +
        `- **Eligibility routing (REQUIRED):** the entered phone decides the experience. Eligible numbers ` +
        `(LAYER_READY) get the Layer prefill happy path; ineligible numbers (LAYER_AUTOFILL_NOT_AVAILABLE) ` +
        `route to the storyboard's **manual onboarding fallback** step. The fallback is **use-case specific** ` +
        `and is whatever the storyboard outlines — linking a bank via real Plaid Link, launching an IDV ` +
        `session, or a generic (non-Plaid) PII entry screen. Wire \`window.goToStep('<manual-fallback-step-id>')\` ` +
        `to that step (the demo-script's designated fallback step; if none is declared, default to the first ` +
        `non-Layer manual host step). Sandbox: \`+14155550000\` → LAYER_NOT_AVAILABLE → (DOB retry) → ` +
        `LAYER_AUTOFILL_NOT_AVAILABLE; the 5155550xxx numbers exercise partial-profile / Extended-Autofill paths ` +
        `(see the plaid-layer-idv-onboarding skill sandbox table).\n` +
        `- \`window._plaidLinkComplete = true\` is set ONLY in \`onSuccess\`.\n\n` +
        `**Post-Layer review step:** render the Layer happy-path result from \`window._layerIdentity\` ` +
        `(name, address, DOB, email — **editable**) AND the linked bank accounts from \`window._layerItems\` ` +
        `(institution + masked account) to demonstrate identity AND bank data. Never hardcode bank names.\n\n` +
        `**Verification method is owned by the IDV template — never a user choice.** Do NOT build a ` +
        `"choose your verification depth" selector (SSN last-4 vs full SSN vs IDV).\n` +
        `**IDV step:** if the demo-script has a SECOND \`plaidPhase:"launch"\` step for identity ` +
        `verification, wire it as a LIVE Plaid Identity Verification launch — a distinct CTA ` +
        `\`data-testid="idv-launch-btn"\` (do NOT reuse link-external-account-btn). On click: fetch ` +
        `\`POST /api/create-idv-link-token\`, then \`Plaid.create({ token, onSuccess:(pt,md)=>{ ` +
        `window._idvId = md.link_session_id; window._idvComplete = true; ` +
        `window.goToStep('<idv-success-step-id>'); }, onEvent:()=>{}, onExit:()=>{} }).open()\` ` +
        `(IDV public_token is null; the id is metadata.link_session_id). The IDV **success** step shows ` +
        `\`POST /identity_verification/get\` → \`status:"success"\` (steps kyc_check / ` +
        `documentary_verification / selfie_check = success) as its apiResponse. If there is NO dedicated ` +
        `IDV launch step, render IDV as a template-driven "verifying identity" screen only. Never show \`failed\`.\n\n` +
        `**Show the behind-the-scenes eligibility + webhooks** (these are invisible to the real user — ` +
        `surface them in the API/JSON panel and/or a small host "behind the scenes" callout so viewers ` +
        `see what Plaid is doing). At the appropriate steps, in order:\n` +
        `1. Launch / phone submit → \`POST /session/token/create\` (Layer session created), then the ` +
        `eligibility result as a Link event \`LAYER_READY\` ("Plaid matched this phone in the Plaid ` +
        `Network"). (Ineligible path would be \`LAYER_NOT_AVAILABLE\`.)\n` +
        `2. Device auth → webhook \`LAYER_AUTHENTICATION_PASSED\` (\`webhook_type:"LAYER"\`) — phone ` +
        `ownership verified.\n` +
        `3. Session finish → webhook \`SESSION_FINISHED\` (\`webhook_type:"LINK"\`, \`status:"SUCCESS"\`, ` +
        `\`public_tokens:[…]\`).\n` +
        `4. Prefill review → \`POST /user_account/session/get\` returning \`identity\` + \`items[]\`.\n` +
        `Use realistic, idealized payloads; never invent fields. Provide these as the steps' ` +
        `\`apiResponse\` (request/response or event JSON) so the JSON panel walks the sequence.`,
    });
  }
  // Mock-Layer template / mobile-skeleton / share-field guardrail blocks REMOVED
  // (2026-05-29). Layer is always the live Plaid Layer Web SDK modal (see the
  // useLayerWebSdk block above) — there is no mobile-mockup path anymore.

  // ── LIVE IDENTITY VERIFICATION (IDV) LAUNCH — multi-launch contract ─────────
  // Emitted whenever the demo-script has a plaidPhase:"launch" step inferred as
  // IDV but the demo is NOT a Layer demo (the Layer block above already wires
  // IDV when Layer is present). A demo may have MULTIPLE real launches — e.g.
  // a real IDV session AND a separate real bank Plaid Link session. Each launch
  // is its OWN live Plaid SDK session with its OWN CTA, token endpoint, and
  // completion flag. This block tells the LLM how to wire the IDV launch so it
  // does not collapse it into the bank launch or build a simulated IDV screen.
  if (hasIdvLaunch && !useRealLayerWebSdk) {
    const idvLaunchIds = idvLaunchSteps.map((s) => s.id).join(', ');
    const allLaunchIds = (demoScript.steps || [])
      .filter((s) => s && String(s.plaidPhase || '').toLowerCase() === 'launch')
      .map((s) => s.id);
    // The step id immediately before the bank (non-IDV) launch — where the fresh
    // bank handler must be (re)created so open() on the CTA is instant.
    const bankPrepPriorStepId = (() => {
      const steps = demoScript.steps || [];
      const idvIds = new Set(idvLaunchSteps.map((s) => s.id));
      const bankIdx = steps.findIndex(
        (s) => s && String(s.plaidPhase || '').toLowerCase() === 'launch' && !idvIds.has(s.id)
      );
      return bankIdx > 0 ? steps[bankIdx - 1]?.id || null : null;
    })();
    contentBlocks.push({
      type: 'text',
      text:
        `## LIVE IDENTITY VERIFICATION (IDV) LAUNCH — REAL SDK (multi-launch demo)\n\n` +
        `This demo has **multiple real Plaid launches** — each \`plaidPhase:"launch"\` step is its OWN ` +
        `live Plaid SDK session with its OWN launch button inside that step's div, its OWN token ` +
        `endpoint, and its OWN completion flag. Launch step ids (in order): ${allLaunchIds.map((id) => `\`${id}\``).join(', ')}. ` +
        `The IDV launch step(s): ${idvLaunchIds ? idvLaunchSteps.map((s) => `\`${s.id}\``).join(', ') : '(none)'}.\n\n` +
        `**IDV launch step — wire it as a REAL Plaid Identity Verification session (NOT a simulated screen):**\n` +
        `- The IDV launch step contains its OWN CTA \`data-testid="idv-launch-btn"\` (its own button INSIDE ` +
        `that step's div). Do **NOT** reuse \`link-external-account-btn\` for the IDV launch — that testid ` +
        `belongs to the bank Plaid Link launch.\n` +
        `- On click, fetch the IDV link token from the dedicated endpoint, then open the real SDK:\n` +
        '```javascript\n' +
        `let _idvHandler = null;\n` +
        `async function launchIdv() {\n` +
        `  const r = await fetch('/api/create-idv-link-token', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client_user_id: window._clientUserId }) });\n` +
        `  if (!r.ok) { console.error('[create-idv-link-token]', r.status); return; }\n` +
        `  const { link_token } = await r.json();\n` +
        `  _idvHandler = Plaid.create({\n` +
        `    token: link_token,\n` +
        `    onSuccess: (public_token, metadata) => {\n` +
        `      // IDV public_token is null; the verification id is metadata.link_session_id.\n` +
        `      window._idvId = (metadata && metadata.link_session_id) || null;\n` +
        `      window._idvComplete = true;          // IDV completion flag (NOT _plaidLinkComplete)\n` +
        `      window.goToStep('<idv-success-step-id>');   // the step AFTER this IDV launch step\n` +
        `    },\n` +
        `    onEvent: () => {},\n` +
        `    onExit: (err) => { console.warn('IDV exited', err); },\n` +
        `  });\n` +
        `  window._idvHandler = _idvHandler;\n` +
        `  _idvHandler.open();\n` +
        `}\n` +
        '```\n' +
        `- Wire the CTA: \`<button data-testid="idv-launch-btn" onclick="launchIdv()">…</button>\`.\n` +
        `- **IDV token is \`products:["identity_verification"]\` ONLY** — \`/api/create-idv-link-token\` ` +
        `produces that token on the backend; never combine identity_verification with auth / income / ` +
        `signal in one token, and never wire IDV through \`/api/create-link-token\`.\n` +
        `- Treat the returned identity as **submitted, not a pass/fail verdict**. The IDV verdict comes from ` +
        `\`POST /identity_verification/get\` → \`status:"success"\` (sub-steps documentary_verification / ` +
        `kyc_check / selfie_check = success). Use that as the IDV-success step's \`apiResponse\`. Never show \`failed\` ` +
        `or an API error in the main flow.\n\n` +
        `**Bank launch step (separate session):** the OTHER \`plaidPhase:"launch"\` step is the bank Plaid ` +
        `Link — CTA \`data-testid="link-external-account-btn"\`, fetch \`POST /api/create-link-token\`, ` +
        `\`Plaid.create({ token, onSuccess })\`, set \`window._plaidLinkComplete = true\` in onSuccess, then ` +
        `\`goToStep\` to its own post-link step. Do NOT merge the two launches; do NOT set ` +
        `\`_plaidLinkComplete\` from the IDV onSuccess (use \`_idvComplete\`).\n` +
        `- **CRITICAL — (re)create the bank handler EAGERLY on the step BEFORE the bank launch (multi-launch).** ` +
        `Because the IDV modal opens a Plaid session BEFORE the bank launch, Plaid's web SDK will NOT composite ` +
        `the bank Link iframe while an earlier handler still holds a session — the boot-created bank handler ` +
        `goes stale after IDV and \`open()\` shows nothing (host card stays up → PLAID_LINK_MODAL_MISSING). ` +
        `Recreate a FRESH handler eagerly when the app navigates INTO the step just before the bank launch ` +
        `(here: \`${bankPrepPriorStepId || '<step before the bank launch>'}\`) — NOT on click. A token-fetch ` +
        `ON click opens the modal ~1-2s too late (after the recorder's iframe-navigation window), so it never ` +
        `records; pre-creating means \`open()\` on click is INSTANT and the iframe is already attached.\n` +
        '```javascript\n' +
        `function bankHandlerConfig(token){ return { token, onSuccess:(pt,md)=>{ /* set _plaidLinkComplete + goToStep(<post-link step>) */ }, onExit:()=>{}, onEvent:()=>{} }; }\n` +
        `// Boot: create once so the recorder's pre-click "handler ready" wait passes.\n` +
        `createBankLinkToken().then(d => { if (d&&d.link_token) window._plaidHandler = Plaid.create(bankHandlerConfig(d.link_token)); });\n` +
        `window._bankPrepStarted = false;\n` +
        `async function prepBankHandler(){\n` +
        `  try { window._idvHandler && window._idvHandler.destroy(); } catch(e){}  window._idvHandler = null;\n` +
        `  try { window._plaidHandler && window._plaidHandler.destroy(); } catch(e){}  window._plaidHandler = null;\n` +
        `  const d = await createBankLinkToken(); if (!d || !d.link_token) { window._bankPrepStarted=false; return; }\n` +
        `  window._plaidHandler = Plaid.create(bankHandlerConfig(d.link_token));   // fresh iframe attaches now\n` +
        `}\n` +
        `// Trigger prep when reaching the step BEFORE the bank launch (wrap goToStep):\n` +
        `(function(){ var orig = window.goToStep; window.goToStep = function(id){ var r = orig.apply(this, arguments);\n` +
        `  if (id === '${bankPrepPriorStepId || '<step-before-bank-launch>'}' && !window._bankPrepStarted){ window._bankPrepStarted = true; prepBankHandler(); }\n` +
        `  return r; }; })();\n` +
        `window.openBankLink = async function(){  // CTA just opens the already-prepped handler\n` +
        `  var t=Date.now(); while(!window._plaidHandler && Date.now()-t<8000){ await new Promise(r=>setTimeout(r,120)); }\n` +
        `  if(!window._plaidHandler) await prepBankHandler();\n` +
        `  if(window._plaidHandler) window._plaidHandler.open();\n` +
        `};\n` +
        '```\n' +
        `This pre-create-then-instant-open rule applies to ANY demo whose bank Link launch follows another ` +
        `real Plaid launch (IDV, Layer, or CRA).\n` +
        `- **NO auto-advance:** neither launch step may auto-advance via setTimeout/onload. Advance ONLY from ` +
        `the SDK \`onSuccess\` callback (\`_idvComplete\` → goToStep for IDV; \`_plaidLinkComplete\` → goToStep ` +
        `for the bank). Each launch button must be INSIDE its own step's div so goToStep doesn't hide it.`,
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
          `         // institution can be null (micro-deposit/manual); name/mask are nullable — default to sandbox values so screens never show blanks.\n` +
          `         window._plaidInstitutionName = (metadata && metadata.institution && metadata.institution.name) || window._plaidInstitutionName || 'First Platypus Bank';\n` +
          `         window._plaidAccountName = (metadata && metadata.accounts && metadata.accounts[0] && metadata.accounts[0].name) || window._plaidAccountName || 'Plaid Checking';\n` +
          `         window._plaidAccountMask = (metadata && metadata.accounts && metadata.accounts[0] && metadata.accounts[0].mask) || window._plaidAccountMask || '0000';\n` +
          `         if (typeof window.paintPlaidVars === 'function') window.paintPlaidVars();\n` +
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
          `   onSuccess callback. PREFERRED: mark any element that shows the bank/account with\n` +
          `   data-plaid-institution / data-plaid-account-name / data-plaid-account-mask — the\n` +
          `   pipeline runtime (window.paintPlaidVars) auto-fills them on load, on every goToStep,\n` +
          `   and after onSuccess. These ALWAYS resolve: they default to "First Platypus Bank" /\n` +
          `   "Plaid Checking" / "0000" before the live session sets them, so a screen is NEVER blank.\n` +
          `   You may also read window._plaidInstitutionName / _plaidAccountName / _plaidAccountMask\n` +
          `   directly (same defaults). Do NOT hardcode a specific bank name in static markup.\n` +
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
          `         window._plaidInstitutionName = (metadata.institution && metadata.institution.name) || window._plaidInstitutionName || 'First Platypus Bank';\n` +
          `         window._plaidAccountName = (metadata.accounts && metadata.accounts[0] && metadata.accounts[0].name) || window._plaidAccountName || 'Plaid Checking';\n` +
          `         window._plaidAccountMask = (metadata.accounts && metadata.accounts[0] && metadata.accounts[0].mask) || window._plaidAccountMask || '0000';\n` +
          `         if (typeof window.paintPlaidVars === 'function') window.paintPlaidVars();\n` +
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
          `   CRA CONSUMER-UI RULE (the host app is what a borrower sees — keep it clean):\n` +
          `   - NEVER render webhook/event names, raw enums, API field names, endpoints, or IDs on the\n` +
          `     consumer host screens — not as text and NOT as a status badge/pill/chip/tag. This\n` +
          `     specifically includes \`USER_CHECK_REPORT_READY\`, \`SESSION_FINISHED\`, \`ITEM_ADD_RESULT\`,\n` +
          `     and the raw \`EXTENSION_OF_CREDIT\` enum. Any UPPER_SNAKE_CASE token is a tell it does not\n` +
          `     belong in the UI.\n` +
          `   - ANTI-PATTERN (do NOT do this): a "Generating your Consumer Report…" loading screen with a\n` +
          `     green \`USER_CHECK_REPORT_READY\` pill above a "View Consumer Report" button. Convey the\n` +
          `     async ready-state with the loading→done transition + the CTA enabling itself — no token.\n` +
          `   - Human status copy only ("Generating your report…" → enabled "View report"); normalize\n` +
          `     permissible purpose for humans ("to review your application for credit").\n` +
          `   - The raw webhook/enum/field belongs in the JSON #api-response-panel or a technical slide,\n` +
          `     or a clearly-labeled Underwriter/Internal-view step — never the borrower's screens.\n\n` +
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
            `   - Trust copy ("256-bit encryption", "Plaid never stores credentials", headline/subtitle) is fine;\n` +
            `     a clickable CTA is not. Do NOT duplicate the SDK "Recommended · Instant verification"\n` +
            `     tile in the host trust column — the live embed owns that recommendation.\n` +
            `   - Manual verification: subtle text link only (e.g. data-testid="connect-manually-link"\n` +
            `     or class connect-manually-link) below/adjacent to the embed; requires\n` +
            `     auth.auth_type_select_enabled in token config.\n` +
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
            `   The container should be a normal block element so the Plaid-rendered iframe fills it naturally.\n` +
            `9. **PRE-LINK PAGE = LIVE INSTITUTION SEARCH (parity with standard Link).** The launch step is the\n` +
            `   integrated pre-link UX: trust headline/bullets/consent **and** the live #plaid-embedded-link-container\n` +
            `   on the **same** step. The Plaid SDK renders the Recommended path — do NOT mirror it in the host column.\n` +
            `   FORBIDDEN: placeholder copy ("Institution search preview", "opens on the next step"),\n` +
            `   static preview mocks, fake institution-search inputs, duplicate Recommended tiles, or splitting\n` +
            `   trust copy on one host step and the SDK on a later bare launch step. One plaidPhase:"launch" step only.\n` +
            `   No "Connecting your bank…" / host spinners where the widget belongs. onSuccess → first\n` +
            `   post-Link host step. Exactly one data-testid="plaid-embedded-link-container" in the app.\n`,
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
    buildMode = 'app+slides',
  } = demoContext;

  const isAppOnlyRun = String(buildMode).toLowerCase() === 'app-only';
  const isAppTierStep = String(step.stepKind || '').toLowerCase() !== 'slide';

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
  // OVERLAY CONTRACT (2026-06-04, re-aligned 2026-06-10): the global
  // #api-response-panel is a fixed overlay that stays COLLAPSED by default on
  // EVERY step; build-qa deliberately screenshots slides with it collapsed and
  // the presenter expands it live. The old "JSON rail must be visible" wording
  // contradicted that contract and systematically dragged every apiResponse
  // slide to ~55-70 ("panel collapsed, no JSON visible"). Score the DATA, not
  // the panel state.
  const apiJsonRailNote =
    hasApiResponsePayload && !isValueSummaryId
      ? `\n\nAPI PANEL OVERLAY CONTRACT: This step includes apiResponse in the demo script. The global right-hand API/JSON side panel (#api-response-panel) is a FIXED OVERLAY that stays COLLAPSED by default on every step — only a thin chevron tab is visible at the right edge; the presenter expands it live during delivery. A collapsed JSON rail is CORRECT and expected in these frames. Do NOT deduct points because the panel is collapsed, because no raw JSON is visible, or because API data is rendered as styled slide content instead of raw JSON — even if the Expected visual state describes the panel as expanded, visible, or "showing JSON" (that description is satisfied by the collapsed overlay + populated panel data). Instead verify the step's concrete API data values (scores, statuses, amounts, field values from apiResponse) are evidenced in the slide body as styled content (cards, key/value rows, metric chips). Deduct only if those concrete values are absent from the slide body.`
      : '';
  // Slide-tier steps are static deck surfaces and follow the Deck Design
  // System's background rhythm + no-sales-CTA rules. The expected-state text
  // sometimes contradicts those contracts (asks for a CTA button, a specific
  // background color, or panel-expansion progression) — the contracts win.
  const isSlideTierStep = !isAppTierStep;
  const slideContractNote = isSlideTierStep
    ? `\n\nSLIDE STEP CONTRACT: This is a static Plaid deck slide.` +
      ` (1) STATIC FRAMES: start/mid/end frames are expected to be identical — do NOT deduct for missing animation, reveal progression, or "no visible change across frames".` +
      ` (2) BACKGROUND VARIANT: the deck design system owns background rhythm; navy, light, cream, and holo are all approved — do NOT deduct if the slide uses a different approved background variant than the Expected visual state describes.` +
      (isValueSummaryId
        ? ` (3) CLOSING CONTRACT: value-summary slides intentionally close with product outcome bullets + declarative copy ONLY; sales CTA buttons are FORBIDDEN by the design system. Do NOT deduct for a missing CTA button even if the Expected visual state mentions a visible CTA — a closing declarative line or the headline satisfies that expectation.`
        : '')
    : '';

  // App-only host/link steps explicitly bind QA to visualState only.
  // In app-only builds the customer-branded UI is the entire deliverable; concrete
  // narration values (scores, decisions, dollar amounts) are intentionally carried
  // by voiceover unless the visualState description explicitly puts them on screen.
  const appOnlyContractNote = (isAppOnlyRun && isAppTierStep)
    ? `\n\nAPP-ONLY HOST STEP CONTRACT: This step renders the customer's host UI; it is NOT a Plaid-branded insight slide. ` +
      `Narration may reference concrete values (scores, decisions, dollar amounts, percentages) that are intentionally carried by voiceover only. ` +
      `Do NOT deduct points for missing on-screen numbers, JSON readouts, or score values UNLESS the Expected visual state above explicitly describes them as visible. ` +
      `The visualState description is the sole contract for what must appear on screen. ` +
      `Continue to deduct points for: missing/incorrect host brand wordmark, navigation drift, missing or incorrect testids, ` +
      `Plaid Link CTA icon size, asset-authenticity violations (inline SVG where library asset is required), animation or ` +
      `state-progression drift when visualState describes them, and any other deviation explicitly required by the visualState.`
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
    apiJsonRailNote +
    slideContractNote +
    appOnlyContractNote;

  // Narration-strict only fires when there's a slide tier expected to show the
  // value, i.e. full builds OR slide-tier steps in any build. App-tier steps in
  // app-only demos carry the value via narration only — that is by design.
  const effectiveNarrationStrict = narrationStrict && !(isAppOnlyRun && isAppTierStep);
  const narrationStrictNote = effectiveNarrationStrict
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
    `- Use approved product names only.\n` +
    `- Narrations play back-to-back as ONE continuous voiceover. PRESERVE each step's\n` +
    `  transitional opener — the clause connecting it to the previous step ("Once Plaid Link\n` +
    `  has authenticated…", "With identity settled…", "That session returns…"). Never delete\n` +
    `  a transition to hit word count; tighten elsewhere in the sentence. You may improve a\n` +
    `  transition, never strip it.`;

  // Build per-step instructions with max word count derived from duration.
  // Neighboring narrations are included so the polish pass can see (and must
  // preserve) the scene-to-scene transitions at each seam.
  const stepInstructions = steps.map((step, i) => {
    const maxWords = Math.floor((step.durationMs / 1000 / 60) * 150);
    return (
      `Step "${step.id}" (${step.durationMs}ms, max ${maxWords} words):\n` +
      `Previous narration: ${steps[i - 1]?.narration ?? '(first step)'}\n` +
      `Original: ${step.narration}\n` +
      `Next narration: ${steps[i + 1]?.narration ?? '(final step)'}`
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
    `- The key reveal lands an OUTCOME/decision (ACCEPT, approved, qualifies, low-risk)\n` +
    `- NARRATE OUTCOMES, DON'T READ THE SCREEN: flag any narration that recites an exact on-screen\n` +
    `  value — a dollar amount ("$2,236"), a numeric score ("Signal score 12", "NAME 88"), an account\n` +
    `  mask / last-4 ("ending 4821"), or an exact timing ("in 2.4 seconds") — as severity "warning",\n` +
    `  rule "narration-reads-metric". The slide/API panel shows the precise value; the voiceover should\n` +
    `  speak to the implication/direction instead (e.g. "income easily clears the threshold", "low-risk —\n` +
    `  cleared to ACCEPT", "her connected checking account is ready"). Account/product NAMES and\n` +
    `  decisions are fine to say; raw numbers are not.\n` +
    `- NARRATION MUST MATCH THE SCREEN: flag (rule "narration-screen-mismatch", severity "warning") any\n` +
    `  specific NAME spoken in narration — an account/plan/card name, institution, or labeled entity —\n` +
    `  that does NOT appear in that step's visualState/apiResponse/slide content. A name said aloud must\n` +
    `  be the one actually rendered (e.g. the Plaid Link account label), never an invented one.\n\n` +
    `Continuity (read the narrations in step order, as ONE continuous voiceover):\n` +
    `- Each scene change should open with connective tissue carrying the previous beat's\n` +
    `  outcome forward ("Once…", "That session returns…", "With identity settled…",\n` +
    `  "Behind that consent…"). Flag any step that starts cold — restarting the story with\n` +
    `  no reference to what just happened — as severity "warning", rule "narration-continuity".\n` +
    `  Exceptions: the opening step, and a deliberate hard act break. Use judgment, not\n` +
    `  pattern-matching — a step connects if its first clause clearly continues the prior\n` +
    `  beat, even without a stock opener.\n` +
    `- Flag two consecutive steps opening with the same word or same connective form ("warning").\n` +
    `- Pay special attention to transitions INTO insight/API steps: the narration should bridge\n` +
    `  the on-screen outcome into the off-screen API work (e.g. "Once Plaid Link has\n` +
    `  authenticated the bank account, behind the scenes the /auth/get API…").\n\n` +
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
  deckDesignSystem = '',
  deckComposition = '',
  valuePropositionStatements = [],
  narration = '',
  slideDesignSkillMarkdown = '',
  templateRouting = null,
  showcaseTemplate = null,
  recentBackgrounds = [],
  regenFeedback = null,
} = {}) {
  const brandName = (brand && brand.name) || 'Plaid';
  const stepId = String(step?.id || '').trim();
  const stepLabel = String(step?.label || '').trim();
  const stepVisual = String(step?.visualState || '').trim();
  const effectiveNarration = String(narration || step?.narration || '').trim();
  const endpoint = String(step?.apiResponse?.endpoint || '').trim();
  const routing = templateRouting || {};
  const recommendedLayout = routing.workhorseLayout || showcaseTemplate?.workhorseLayout || '';
  const recommendedT = routing.slideTemplate || showcaseTemplate?.slideTemplate || 'T3';

  const system =
    `You are generating ONE Plaid Deck Design System slide as a surgical insertion into an existing demo app. ` +
    // LAYOUT AUTONOMY (2026-07-01): the routed template is a SUGGESTION, not a
    // mandate. Older builds forced "copy this skeleton exactly / do NOT invent a
    // different layout", which produced uniform, sometimes-poorer slides; the
    // freer 2026-06-10 build chose better layouts. Let the model pick the layout
    // that best fits THIS slide's content from the T1–T11 Deck Design System, and
    // rely on the deterministic autofit (post-slides) to shrink any overflow —
    // favor the clearest layout over cramming.
    `A SUGGESTED showcase template is provided (data-slide-template="${recommendedT}" data-workhorse-layout="${recommendedLayout}") as a strong starting point. ` +
    `But YOU choose the layout that best communicates THIS slide's content: if a different Deck Design System layout (T1–T11 / a different workhorse layout) fits the data better, use it and set data-slide-template / data-workhorse-layout accordingly. ` +
    `Match the layout to how much content there is — pick the cleanest fit and do NOT overfill; overflow is auto-shrunk to fit the canvas, so favor clarity over cramming. Only fall back to a generic T3 statement shell when nothing richer suits the content. ` +
    `Return a single HTML fragment: <div data-testid="step-${stepId}" class="step"><div class="slide-root" data-slide-template="{your chosen T#}" data-workhorse-layout="{your chosen layout}">...</div></div>. ` +
    `Use the canonical shell: .frame, .chrome-logo, .eyebrow-tag, .h-title (with one <em> Bowery italic accent), .slide-stack body. Do NOT include .chrome-foot. ` +
    // SPACING PRIMITIVES (2026-07-01): layout is free, but STRUCTURE must use the
    // Deck class primitives so spacing is correct. A prior build emitted API-result
    // rows as bare <div><span>label</span><span>value</span></div>, which render
    // with NO space between label and value ("KYC checkSuccess", "STATUSLeslie
    // Knope"). Enforce the field-row primitive.
    `For every label/value, key/stat, or field-result pair (e.g. API-result rows like "KYC check → Success", "STATUS → …"), use the field-row primitive: <div class="sc-field-row"><span class="sc-field-key">LABEL</span><span class="sc-field-value">VALUE</span></div>. .sc-field-row is flex with justify-content:space-between and a gap, so the label sits left and the value right with clear separation. NEVER put a label span and a value span adjacent inside a plain <div> — they will jam together with no space. Use the .sc-* class primitives for structure/spacing; do NOT hand-roll inline-styled two-span rows. ` +
    `Slides are Plaid-branded ONLY — never use customer/host brand colors, Workhorse themes, runtime.js, data-anim, or Chart.js inside .slide-root. ` +
    `Do NOT include <script>, do NOT use display:inline-block inside .slide-root, do NOT add inline display on the step div, do NOT wrap output in markdown fences.`;

  const vps = Array.isArray(valuePropositionStatements)
    ? valuePropositionStatements.slice(0, 4)
    : [];

  const slideSkillBlock = String(slideDesignSkillMarkdown || '').trim();

  // Extract Plaid product names from the narration so the LLM has a focused
  // checklist for the narration-concrete-values scanner (slide-narration-drift).
  // The same product phrases that build-qa's scanSlideNarrationConcreteValues
  // looks for in the rendered slide text. Keep in sync with that list.
  const NARRATION_PRODUCT_PHRASES = [
    'Trust Index', 'Ti2',
    'Plaid Layer', 'Plaid Signal', 'Plaid Identity Verification', 'Plaid IDV',
    'Plaid Monitor', 'Plaid Assets', 'Plaid Protect', 'Plaid Instant Auth',
    'Plaid Liabilities', 'Plaid Investments Move', 'Plaid Investments',
    'Bank Income', 'Cash Advance Score', 'Earned Wage Access',
  ];
  const narrationProducts = [];
  if (effectiveNarration) {
    for (const phrase of NARRATION_PRODUCT_PHRASES) {
      const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (re.test(effectiveNarration)) narrationProducts.push(phrase);
    }
  }

  let userText =
    `# SLIDE INSERTION — step "${stepId}"\n\n` +
    `Customer context (copy only — NOT slide palette): ${brandName}\n` +
    (stepLabel ? `Label: ${stepLabel}\n` : '') +
    (endpoint ? `API endpoint: ${endpoint}\n` : '') +
    (effectiveNarration ? `Narration: ${effectiveNarration}\n` : '') +
    (stepVisual ? `Expected visual: ${stepVisual}\n` : '') +
    (narrationProducts.length
      ? `\nProduct names the narration mentions — these MUST appear in the slide's rendered text (eyebrow, headline, bullets, or footer label): ${narrationProducts.map((p) => `"${p}"`).join(', ')}.\n`
      : '') +
    `\n## ${SLIDE_HOST_ISOLATION_BLOCK}\n\n`;

  // Slide-fix regeneration feedback: when this step was rejected by a prior QA
  // pass, give the model the SPECIFIC measured complaints (overflow pixels,
  // missing fields, jammed pairs) so it fixes them — blind regeneration without
  // this just reproduces the same dense layout. Authorship fix per the slide
  // skill ("trim the content"), never a CSS clamp/scale. Highest salience.
  const _rf = regenFeedback && typeof regenFeedback === 'object' ? regenFeedback : null;
  const _rfIssues = _rf && Array.isArray(_rf.issues) ? _rf.issues.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (_rf && (_rfIssues.length || _rf.overflowPx)) {
    userText +=
      `## ⚠ PREVIOUS ATTEMPT FAILED QA — FIX EVERY ISSUE BELOW (highest priority)\n` +
      `Your last version of THIS slide scored ${Number.isFinite(_rf.score) ? _rf.score : '?'}/100 and was rejected. ` +
      `Regenerate so each issue is resolved — keep what worked, change what's flagged:\n` +
      (_rfIssues.length ? _rfIssues.map((s, i) => `  ${i + 1}. ${s}`).join('\n') + '\n' : '') +
      (_rf.overflowPx
        ? `\nCRITICAL — CONTENT OVERFLOW: the previous slide's content extended ~${_rf.overflowPx}px past the 1440×900 canvas and was clipped (overflow:hidden). You MUST emit materially LESS content this time: drop the lowest / least-essential row or card, cut every bullet to one short line, reduce the number of rows/cards, and tighten the .slide-stack gap. The whole slide must fit ~760px of vertical content space — when in doubt, show fewer denser rows rather than risk a clipped bottom row.\n`
        : '') +
      `\n`;
  }

  if (slideSkillBlock) {
    userText += `## PLAID SLIDE DESIGN SKILL (authoritative)\n${slideSkillBlock}\n\n`;
  }

  userText +=
    `\n## OUTPUT CONTRACT (REQUIRED)\n` +
    `- Emit ONLY <div data-testid="step-${stepId}" class="step"> ... </div>.\n` +
    `- Exactly ONE child: <div class="slide-root" data-slide-template="T1|T2|...|T11" data-workhorse-layout="layout-name"> with optional background class light|cream|holo on .slide-root.\n` +
    `- Inner structure: .frame > .chrome-logo + .eyebrow-tag + .h-title + template body in .slide-stack (T1 title may omit eyebrow). **NEVER add .chrome-foot** — pipeline slides have NO footer row. Footer-style partnership labels overlap body copy at 1280×800 and trigger a build-QA blocker. WRONG: \`<div class="chrome-foot"><span>Plaid × {brand}</span></div>\`. RIGHT: put "Plaid × {brand} · {section}" inside .eyebrow-tag only.\n` +
    `- Headline: sentence case, ends with period, exactly one <em> Bowery Street italic accent in .h-title.\n` +
    `- **Typography: templates own sizing.** Use the canonical slide-template classes (.h-title, .slide-body-text, .hero-stat-value, .eyebrow-tag, .mono-block) and let slide.css + pipeline-slide-contract.css pick the size. Do NOT add inline \`font-size\` to those elements unless content density or rendered overlap genuinely demands it (e.g. a hero stat clips or two blocks overlap) — then reduce intelligently and stay readable. **Long slide titles (~7+ words) are auto-condensed 20% by the pipeline (post-slides .is-long), so do NOT manually size \`.h-title\` to fit on one line.** No hard floor/ceiling; the pipeline no longer enforces 24px-minimum or per-template maximums.\n` +
    `- Wrap main body (headline + stats + cards) in <div class="slide-stack">. ` +
    `When data-workhorse-layout="code": use <div class="slide-stack sc-code-split"> with <div class="sc-code-copy"> (h-title + slide-body-text) on the LEFT and <div class="slide-code-block sc-code-pane"><pre class="sc-code-pre"> on the RIGHT — never stack code below the headline.\n` +
    `- Layout: flex/grid + gap only (no inline-block).\n` +
    `- **Mint cap (HARD):** maximum 3 total references to \`--plaid-teal-500\` or \`#42F0CD\` per slide — counted across class names, inline styles, and CSS. Reserve mint for ONE primary eye-draw moment (a single stat, a single CTA accent, or a single chip). For supporting text, use \`var(--plaid-white)\` or \`rgba(255,255,255,0.78)\` on navy; \`var(--plaid-ink-900)\` on light/cream/holo. **WRONG**: 8+ mint hex/var references stacked across cards. **RIGHT**: 1–3 mint references, all clustered on the focal element.\n` +
    `- **Text contrast on light variants (HARD — build-QA blocker \`slide-text-contrast\`):** when .slide-root carries \`light\`, \`cream\`, or \`holo\`, NEVER style any text white or near-white (\`#fff\`, \`var(--plaid-white)\`, \`rgba(255,255,255,…)\`) and never use mint for accents — white and mint are invisible on light surfaces (~1.1–1.3:1 contrast). Use \`var(--plaid-ink-900)\` / \`rgba(2,37,68,…)\` for text and \`var(--plaid-blue-600)\` for accents. The contract CSS now ink-paints defaults on light variants — do not fight it with inline white.\n` +
    `- **Forbidden sales CTAs (HARD — build-QA blocker):** Do NOT add buttons, pill CTAs, or prominent action lines for: contact Plaid, contact Account Manager, start a free trial, Start a POC, perform a retro analysis / run the production retro / start your retro. Value-summary slides close with product outcome bullets + declarative copy only.\n` +
    `- **Partnership / section labels:** put "Plaid × {customer}" and product names in .eyebrow-tag only — never in a footer row. NEVER write "Plaid × Plaid" — if the customer brand name is unknown or is itself "Plaid", use "Plaid · {product/section}" instead.\n` +
    `- **Plaid logo (HARD — build-QA blocker):** NEVER invent a logo (no SVG, no four-dot icon grid, no "PLAID" text, no CSS shapes). ` +
    `Either use exactly one bundled horizontal wordmark: <img class="chrome-logo" src="assets/logos/plaid-horizontal-white.png" alt=""> ` +
    `(navy), plaid-horizontal-dark.png (light/cream/holo), or plaid-horizontal-holograph.png on holo — OR omit .chrome-logo entirely (T1 may omit).\n` +
    `- **Logo placement (HARD):** Do NOT inline style on .chrome-logo. CSS sets top-right placement (75px above eyebrow) at 28px height via slide.css / pipeline-slide-contract.css. Showcase preview uses ~140px for gallery only — never copy that scale.\n` +
    `- REQUIRED attrs on .slide-root: data-slide-template="${recommendedT}" data-workhorse-layout="${recommendedLayout}".\n` +
    `- Do NOT add JSON rail inside the step (#api-response-panel is global).\n` +
    `- **Vertical fit (HARD — build-QA blocker):** ALL content must fit inside the slide canvas at 1440×900 — no card, row, chart bar, or score chip may extend past the .slide-root edge (clipped content like a 4th field-score row cut off at the bottom is a scored defect). When a field table / score list / metric grid has 4+ rows, make it fit by TIGHTENING SPACING AND SIZE — reduce .slide-stack gap (e.g. 32px → 20px), trim row padding, and step the row value font down one notch — rather than letting the last row overflow. Fewer, denser rows beat clipped rows.\n` +
    `- **Evidence completeness (HARD — vision QA deducts for gaps):** every concrete value the narration or Expected visual state mentions (masked account numbers, routing numbers, scores, statuses, dollar amounts, dates) must appear as styled slide content — pull realistic values from the step's apiResponse. If the Expected visual state describes a list (e.g. transactions with ALL-CAPS merchants and posted dates), render a compact 3–4 row version of it; never replace a described list with summary chips only. If narration says values were "returned" or "retrieved", show the values, not just a count.\n` +
    `- **Label/value pairs (HARD — vision QA flags jammed text):** every label+value pair needs explicit visual separation — a flex row with \`gap\` or \`justify-content: space-between\`, never bare adjacent inline spans (WRONG: "PHONE_NUMBER98", "KYB NAME ON FILEPixel & Paper Co"). The value renders AFTER its label, never before (WRONG: "95LEGAL_NAME"). Humanize API field names in display labels ("LEGAL NAME", "PHONE", "EMAIL" — not "LEGAL_NAME"); raw snake_case belongs only in the .mono-block endpoint line or code panes.\n` +
    (Array.isArray(recentBackgrounds) && recentBackgrounds.length
      ? `- **Background rhythm:** preceding slides in DOM order use these backgrounds: ${recentBackgrounds.join(', ')}. No more than 4 navy slides may run consecutively — if the last 3+ are navy, give this slide a light, cream, or holo background class (on .slide-root) when the template allows it.\n`
      : '') +
    `- Do NOT include emojis.\n\n`;

  if (vps.length) {
    userText +=
      `## APPROVED VALUE PROPOSITIONS (slides only)\n` +
      vps.map((v) => `- ${v}`).join('\n') + '\n\n';
  }

  if (slideTemplateRules) {
    userText += `## PIPELINE SLIDE RULES\n${String(slideTemplateRules).slice(0, 4000)}\n\n`;
  }
  if (deckDesignSystem) {
    userText += `## DESIGN SYSTEM (tokens + shell)\n${String(deckDesignSystem).slice(0, 6000)}\n\n`;
  }
  if (deckComposition) {
    userText += `## COMPOSITION RULES\n${String(deckComposition).slice(0, 4000)}\n\n`;
  }
  if (showcaseTemplate?.skeletonHtml) {
    userText +=
      `## RECOMMENDED SHOWCASE TEMPLATE (REQUIRED — adapt copy only)\n` +
      `Template: ${showcaseTemplate.name || routing.templateId} · category: ${routing.category || showcaseTemplate.category} · ` +
      `${recommendedT} · workhorse-layout: ${recommendedLayout}\n` +
      (routing.whenToUse || showcaseTemplate.whenToUse ? `When: ${routing.whenToUse || showcaseTemplate.whenToUse}\n` : '') +
      (routing.avoidWhen || showcaseTemplate.avoidWhen ? `Avoid: ${routing.avoidWhen || showcaseTemplate.avoidWhen}\n` : '') +
      (routing.rationale ? `Router rationale: ${routing.rationale}\n` : '') +
      `Rules: Copy skeleton structure exactly; replace {HEADLINE}/{BODY}/{EYEBROW} tokens with step narration; do NOT invent a different layout.\n` +
      `\`\`\`html\n${String(showcaseTemplate.skeletonHtml).slice(0, 6000)}\n\`\`\`\n\n`;
  }
  if (Array.isArray(routing.alternates) && routing.alternates.length) {
    userText +=
      `## ALTERNATE TEMPLATES (only if clearly better fit)\n` +
      routing.alternates.map((a) => `- ${a.templateId} (${a.workhorseLayout}, score ${a.score})`).join('\n') +
      '\n\n';
  }
  if (slideTemplateCss) {
    userText +=
      `## SLIDE CSS (injected in host <head> — do NOT re-emit <style>)\n` +
      `PPTX export font swap: Manrope / Playfair Display / JetBrains Mono.\n` +
      `\`\`\`css\n${String(slideTemplateCss).slice(0, 2500)}\n\`\`\`\n\n`;
  }

  userText +=
    `## STEP JSON (context only)\n` +
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
  renderBrandBlock,
  buildResearchPrompt,
  buildScriptGenerationPrompt,
  stripPromptLevelNoSlidesDirectives,
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
