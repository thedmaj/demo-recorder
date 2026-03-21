'use strict';
/**
 * brand-extract.js
 *
 * Extracts brand colors, fonts, and design tokens for a company, then writes
 * a brand profile JSON to brand/<slug>.json for use by build-app.js.
 *
 * Resolution order:
 *   1. Brandfetch API  (fast, accurate for known brands)
 *   2. Playwright CSS extraction  (fallback — crawls the company website)
 *   3. Claude Haiku normalization  (converts raw tokens → brand profile schema)
 *
 * Always regenerates brand/<slug>.json on every pipeline run — no caching.
 *
 * Reads:  out/demo-script.json   (for persona.company + optional brandUrl)
 *         out/ingested-inputs.json (for Brand URL field if present in prompt)
 * Writes: brand/<slug>.json
 *
 * Usage:
 *   node scripts/scratch/scratch/brand-extract.js
 *   node scripts/scratch/scratch/brand-extract.js --brand=chase --url=https://www.chase.com
 */

require('dotenv').config({ override: true });

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = process.env.PIPELINE_RUN_DIR || path.join(PROJECT_ROOT, 'out');
const BRAND_DIR    = path.join(PROJECT_ROOT, 'brand');
const SCRIPT_FILE  = path.join(OUT_DIR, 'demo-script.json');
const INGEST_FILE  = path.join(OUT_DIR, 'ingested-inputs.json');

const BRANDFETCH_API_KEY   = process.env.BRANDFETCH_API_KEY;
const BRANDFETCH_CLIENT_ID = process.env.BRANDFETCH_CLIENT_ID;

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const brandArg = process.argv.find(a => a.startsWith('--brand='));
  const urlArg   = process.argv.find(a => a.startsWith('--url='));
  return {
    forcedSlug: brandArg ? brandArg.replace('--brand=', '').toLowerCase() : null,
    forcedUrl:  urlArg   ? urlArg.replace('--url=', '')                  : null,
  };
}

// ── Slug normalisation ────────────────────────────────────────────────────────

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ── Load demo-script to get company + brand URL ───────────────────────────────

function loadContext() {
  let company = null, brandUrl = null;

  if (fs.existsSync(SCRIPT_FILE)) {
    try {
      const script = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
      company = script.persona?.company || null;
    } catch {}
  }

  // Look for "Brand URL:" line in ingested-inputs
  if (fs.existsSync(INGEST_FILE)) {
    try {
      const ingest = JSON.parse(fs.readFileSync(INGEST_FILE, 'utf8'));
      // Support both legacy {rawPrompt/prompt} and current {texts:[{filename,content}]} format
      const promptText = ingest.rawPrompt || ingest.prompt ||
        (ingest.texts || []).map(t => t.content || '').join('\n');
      const urlMatch = promptText.match(/Brand\s+URL\s*:\s*(https?:\/\/\S+)/i);
      if (urlMatch) brandUrl = urlMatch[1];
    } catch {}
  }

  return { company, brandUrl };
}

// ── Brandfetch API lookup ─────────────────────────────────────────────────────

/**
 * Looks up brand data from Brandfetch by domain.
 * Returns raw Brandfetch response or null on failure.
 */
async function fetchFromBrandfetch(domain) {
  if (!BRANDFETCH_API_KEY) return null;

  const url = `https://api.brandfetch.io/v2/brands/${encodeURIComponent(domain)}`;
  console.log(`[BrandExtract] Brandfetch lookup: ${domain}`);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${BRANDFETCH_API_KEY}`,
        ...(BRANDFETCH_CLIENT_ID ? { 'X-Brandfetch-Client-Id': BRANDFETCH_CLIENT_ID } : {}),
      },
    });

    if (!res.ok) {
      console.log(`[BrandExtract] Brandfetch: ${res.status} — ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    if (!data || data.statusCode === 404 || (!data.colors && !data.fonts)) {
      console.log('[BrandExtract] Brandfetch: no usable data returned');
      return null;
    }

    console.log(`[BrandExtract] Brandfetch: found ${data.name || domain}`);
    return data;
  } catch (err) {
    console.warn(`[BrandExtract] Brandfetch fetch error: ${err.message}`);
    return null;
  }
}

/**
 * Guess a company's primary domain from its name.
 * Simple heuristic — works for Fortune 500 names.
 */
function guessDomain(companyName) {
  const name = companyName.toLowerCase()
    .replace(/\s+(bank|financial|group|inc|corp|co|ltd|llc)$/i, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
  return `${name}.com`;
}

// ── Playwright CSS fallback ───────────────────────────────────────────────────

/**
 * Crawls a URL with Playwright and extracts CSS design tokens.
 * Returns a raw token object or null on failure.
 */
async function extractWithPlaywright(url) {
  console.log(`[BrandExtract] Playwright CSS extraction: ${url}`);
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000); // let fonts/styles settle

    const tokens = await page.evaluate(() => {
      const root = document.documentElement;
      const rootStyle = getComputedStyle(root);

      // CSS custom properties from :root
      const cssVars = {};
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === ':root') {
              for (const prop of rule.style) {
                if (prop.startsWith('--')) {
                  cssVars[prop] = rule.style.getPropertyValue(prop).trim();
                }
              }
            }
          }
        } catch {}
      }

      // Google Fonts imports
      const googleFonts = [...document.querySelectorAll('link[href*="fonts.googleapis"]')]
        .map(l => l.href);

      // Computed styles from key elements
      const bodyStyle  = getComputedStyle(document.body);
      const h1El       = document.querySelector('h1, h2, [class*="heading"], [class*="title"]');
      const btnEl      = document.querySelector('button[class*="primary"], .btn-primary, [class*="cta"], button');
      const navEl      = document.querySelector('nav, header, [class*="nav"], [class*="header"]');

      return {
        cssVars,
        googleFonts,
        bodyBg:       bodyStyle.backgroundColor,
        bodyFont:     bodyStyle.fontFamily,
        bodyColor:    bodyStyle.color,
        h1Font:       h1El ? getComputedStyle(h1El).fontFamily : null,
        btnBg:        btnEl ? getComputedStyle(btnEl).backgroundColor : null,
        btnColor:     btnEl ? getComputedStyle(btnEl).color : null,
        navBg:        navEl ? getComputedStyle(navEl).backgroundColor : null,
        pageTitle:    document.title,
      };
    });

    console.log(`[BrandExtract] Playwright: extracted tokens from "${tokens.pageTitle}"`);
    return tokens;
  } catch (err) {
    console.warn(`[BrandExtract] Playwright extraction failed: ${err.message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Claude Haiku normalisation ────────────────────────────────────────────────

/**
 * Uses Claude Haiku to convert raw brand data (Brandfetch JSON or Playwright tokens)
 * into a clean brand profile matching the brand/*.json schema.
 */
async function normalizeToBrandProfile(rawData, companyName, slug) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const schemaExample = {
    $schema: 'brand-profile/v1',
    name: companyName,
    slug,
    mode: 'light or dark',
    colors: {
      bgPrimary: '#hex', bgGradient: 'css gradient or null',
      accentCta: '#hex', textPrimary: '#hex',
      textSecondary: '#hex or rgba', textTertiary: '#hex or rgba',
      accentBorder: '#hex or rgba', accentBgTint: '#hex or rgba',
      error: '#hex', success: '#hex',
      surfaceCard: '#hex or null', surfaceCardBorder: '#hex or null',
      navBg: '#hex or null', navAccentStripe: '#hex or null', footerBg: '#hex or null',
    },
    typography: {
      fontHeading: 'full font-family stack', fontBody: 'full font-family stack',
      fontMono: '"SF Mono", "Fira Code", Consolas, monospace',
      googleFontsImport: '@import url(...) or null',
      scaleH1: '32px/700', scaleH2: '24px/600', scaleH3: '18px/600', scaleBody: '15px/400',
      headingLetterSpacing: '-0.02em', headingLineHeight: '1.2', bodyLineHeight: '1.6',
    },
    motion: {
      stepTransition: 'opacity 0.3s ease, transform 0.3s ease',
      cardEntrance: 'fadeIn + translateY(10px → 0) 0.4s ease',
      buttonHover: 'all 0.2s ease', modalScale: 'scale(0.95 → 1.0) 0.25s ease',
      loadingIndicatorColor: '#hex or null',
    },
    atmosphere: {
      overlayBackdropFilter: 'blur(8px)', cardBorderRadius: '8px',
      cardBoxShadow: '0 2px 8px rgba(0,0,0,0.08)', cardPadding: '32px',
      maxContentWidth: '1440px', sidebarWidth: 'null or px value',
    },
    sidePanels: {
      bg: '#hex', accentColor: '#hex',
      jsonKeyColor: '#hex', jsonStringColor: '#hex', jsonNumberColor: '#hex',
    },
    logo: {
      svgOrEmoji: 'emoji or null', wordmark: 'COMPANY NAME or null',
      letterSpacing: '0.1em', fontWeight: '700', fontSize: '16px', color: '#hex',
    },
    promptInstructions: 'One paragraph describing key layout patterns, nav structure, sidebar, button styles, footer, and any distinctive brand UI patterns for an app demo.',
  };

  const prompt =
    `You are a brand design expert. Convert the following raw brand data for "${companyName}" ` +
    `into a clean brand profile JSON matching the schema below.\n\n` +
    `Rules:\n` +
    `- mode: "dark" if background is dark (#222 or darker), "light" if light\n` +
    `- Use exact hex values found in the data; infer reasonable values for missing fields\n` +
    `- fontHeading and fontBody: use the brand's actual font stack from the data\n` +
    `- googleFontsImport: include if a Google Fonts URL was found, else null\n` +
    `- promptInstructions: write a concise, specific paragraph about the brand's UI layout patterns\n` +
    `- sidePanels: always dark bg (#111 range) regardless of brand mode; accent = brand CTA color\n` +
    `- Respond with ONLY valid JSON — no markdown fences, no explanation\n\n` +
    `TARGET SCHEMA:\n${JSON.stringify(schemaExample, null, 2)}\n\n` +
    `RAW BRAND DATA:\n${JSON.stringify(rawData, null, 2)}`;

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('[BrandExtract] Claude returned no JSON');

  return JSON.parse(jsonMatch[0]);
}

// ── Brandfetch → raw data adapter ─────────────────────────────────────────────

function brandfetchToRaw(data) {
  // Flatten Brandfetch response into a simple object for Haiku to normalize
  const colors = (data.colors || []).map(c => ({
    hex:  c.hex,
    type: c.type, // 'dominant', 'background', 'accent', 'border', etc.
    brightness: c.brightness,
  }));

  const fonts = (data.fonts || []).map(f => ({
    name:   f.name,
    type:   f.type, // 'title', 'body'
    origin: f.origin, // 'google', 'custom', etc.
    url:    f.cssUrl || null,
  }));

  const logos = (data.logos || []).flatMap(l => l.formats || []).map(f => ({
    src:    f.src,
    format: f.format,
    width:  f.width,
    height: f.height,
  })).slice(0, 3);

  return {
    source:      'brandfetch',
    name:        data.name || data.domain,
    domain:      data.domain,
    description: data.description,
    colors,
    fonts,
    logos,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { forcedSlug, forcedUrl } = parseArgs();
  const { company, brandUrl } = loadContext();

  const url         = forcedUrl  || brandUrl;

  // Derive company name: prefer demo-script, then URL hostname, then forced slug
  let derivedCompany = company || forcedSlug;
  if (!derivedCompany && url) {
    // Extract company name from URL hostname (e.g. wellsfargo.com → wellsfargo)
    try {
      derivedCompany = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    } catch {}
  }
  const companyName = derivedCompany || 'Unknown';
  const slug        = forcedSlug || toSlug(companyName);

  if (slug === 'plaid') {
    console.log(`[BrandExtract] Brand "${slug}" — no extraction needed (using built-in defaults)`);
    return null;
  }
  if (slug === 'unknown' && !url) {
    console.log(`[BrandExtract] Brand "unknown" with no URL — no extraction needed (using built-in defaults)`);
    return null;
  }

  fs.mkdirSync(BRAND_DIR, { recursive: true });

  const profilePath = path.join(BRAND_DIR, `${slug}.json`);

  let rawData = null;

  // ── 1. Try Brandfetch ──────────────────────────────────────────────────────
  const domain = url
    ? new URL(url).hostname.replace(/^www\./, '')
    : guessDomain(companyName);

  const brandfetchData = await fetchFromBrandfetch(domain);
  if (brandfetchData) {
    rawData = brandfetchToRaw(brandfetchData);
  }

  // ── 2. Playwright fallback ─────────────────────────────────────────────────
  if (!rawData && url) {
    const playwrightTokens = await extractWithPlaywright(url);
    if (playwrightTokens) {
      rawData = { source: 'playwright', name: companyName, domain, ...playwrightTokens };
    }
  }

  if (!rawData) {
    console.warn(`[BrandExtract] No brand data found for "${companyName}" — brand/${slug}.json will not be created`);
    console.warn(`[BrandExtract] Tip: add "Brand URL: https://www.${domain}" to inputs/prompt.txt to enable Playwright fallback`);
    return null;
  }

  // ── 3. Normalize with Claude Haiku ────────────────────────────────────────
  console.log(`[BrandExtract] Normalizing brand data with Claude Haiku...`);
  let profile;
  try {
    profile = await normalizeToBrandProfile(rawData, companyName, slug);
  } catch (err) {
    console.error(`[BrandExtract] Haiku normalization failed: ${err.message}`);
    return null;
  }

  // Ensure required fields
  profile.$schema = 'brand-profile/v1';
  profile.name    = profile.name || companyName;
  profile.slug    = slug;
  profile._source = rawData.source;
  profile._extractedAt = new Date().toISOString();

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  console.log(`[BrandExtract] Wrote brand/${slug}.json (${profile.name}, mode: ${profile.mode})`);

  return profile;
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('[BrandExtract] Fatal:', err.message);
    process.exit(1);
  });
}
