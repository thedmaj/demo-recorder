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
 * Reads:  out/demo-script.json   (persona.company — present after script stage in orchestrator)
 *         out/ingested-inputs.json (Brand URL: line; or first https URL in prompt heuristics)
 * Writes: brand/<slug>.json
 *         PIPELINE_RUN_DIR/brand-extract.json (run sentinel for dashboard)
 *
 * Usage:
 *   node scripts/scratch/scratch/brand-extract.js
 *   node scripts/scratch/scratch/brand-extract.js --brand=chase --url=https://www.chase.com
 */

require('dotenv').config({ override: true });

const fs        = require('fs');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { requireRunDir, getRunLayout } = require('../utils/run-io');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR      = requireRunDir(PROJECT_ROOT, 'brand-extract');
const RUN_LAYOUT   = getRunLayout(OUT_DIR);
const BRAND_DIR    = RUN_LAYOUT.brandDir;
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

/** First marketing-site URL in prompt (skips Plaid/docs links). */
function inferBrandUrlFromPrompt(promptText) {
  if (!promptText || typeof promptText !== 'string') return null;
  const head = promptText.split('\n').slice(0, 50).join('\n');
  const re = /https?:\/\/[^\s\])"'<>]+/gi;
  const skip = /plaid\.com|cdn\.|github\.com|localhost|example\.com|googleapis|gstatic|schema\.org/i;
  const seen = new Set();
  let m;
  while ((m = re.exec(head)) !== null) {
    let raw = m[0].replace(/[.,;]+$/, '');
    try {
      const u = new URL(raw);
      if (skip.test(u.hostname)) continue;
      const origin = u.origin;
      if (seen.has(origin)) continue;
      seen.add(origin);
      return origin;
    } catch (_) {}
  }
  return null;
}

function writeRunMeta(payload) {
  try {
    const p = path.join(OUT_DIR, 'brand-extract.json');
    const scoped = path.join(RUN_LAYOUT.brandDir, 'brand-extract.json');
    const body = JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2);
    fs.writeFileSync(
      p,
      body
    );
    fs.writeFileSync(scoped, body);
  } catch (e) {
    console.warn(`[BrandExtract] Could not write brand-extract.json: ${e.message}`);
  }
}

function loadContext(options) {
  const quiet = options && options.quiet === true;
  let company = null;
  let brandUrl = null;
  let promptText = '';

  if (fs.existsSync(SCRIPT_FILE)) {
    try {
      const script = JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8'));
      company = script.persona?.company || null;
    } catch (_) {}
  }

  if (fs.existsSync(INGEST_FILE)) {
    try {
      const ingest = JSON.parse(fs.readFileSync(INGEST_FILE, 'utf8'));
      promptText = ingest.rawPrompt || ingest.prompt ||
        (ingest.texts || []).map(t => t.content || '').join('\n');
      const urlMatch = promptText.match(/Brand\s+URL\s*:\s*(https?:\/\/\S+)/i);
      if (urlMatch) brandUrl = urlMatch[1].replace(/[.,;]+$/, '');
    } catch (_) {}
  }

  if (!brandUrl) {
    const inferred = inferBrandUrlFromPrompt(promptText);
    if (inferred) {
      brandUrl = inferred;
      if (!quiet) console.log(`[BrandExtract] Inferred brand URL from prompt: ${brandUrl}`);
    }
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
 * Captures a 1440×900 viewport screenshot of the brand marketing URL for build-time
 * visual inspiration only (passed to the app generator as a reference image).
 * @param {string} url
 * @param {string} outPath absolute path to write PNG
 * @returns {Promise<boolean>}
 */
async function captureBrandSiteReferenceScreenshot(url, outPath) {
  if (!url || process.env.SKIP_BRAND_SITE_SCREENSHOT === '1') return false;
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: outPath, fullPage: false, type: 'png' });
    console.log(`[BrandExtract] Site reference screenshot: ${path.relative(PROJECT_ROOT, outPath)}`);
    return true;
  } catch (err) {
    console.warn(`[BrandExtract] Site reference screenshot skipped: ${err.message}`);
    return false;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Crawls a URL with Playwright and extracts CSS design tokens.
 * Returns a raw token object or null on failure.
 */
/**
 * Multi-page crawl that captures realism inputs the single-page Playwright
 * extraction can't get: nav-item labels, footer regulatory text, and per-
 * page reference screenshots. Best-effort — we ignore 404s + timeouts and
 * just return what we got.
 *
 * Returns:
 *   {
 *     navItems:       Array<{ label, href }>      // deduplicated, top 12
 *     footerText:     string                       // raw concatenated footer text
 *     copyright:      string|null                  // first plausible © line
 *     disclosures:    Array<string>                // FDIC / Equal Housing / etc, verbatim
 *     nmlsId:         string|null                  // "NMLS [ID] 1234567" if found
 *     referencePages: Array<{ url, screenshot }>   // best-effort screenshots
 *   }
 */
async function crawlAdditionalBrandPages(homeUrl, opts = {}) {
  const out = {
    navItems: [],
    footerText: '',
    copyright: null,
    disclosures: [],
    nmlsId: null,
    referencePages: [],
  };
  if (!homeUrl) return out;

  // Best-effort path set. Most banks' marketing pages are crawl-friendly;
  // post-login pages are not. We only try public marketing variants.
  const pathsToTry = (opts.paths || ['', 'sign-in', 'about', 'privacy', 'security']).slice(0, 5);
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    });

    for (const subPath of pathsToTry) {
      const url = subPath ? new URL(subPath, homeUrl).toString() : homeUrl;
      let page;
      try {
        page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await page.waitForTimeout(800); // brief settle

        const pageData = await page.evaluate(() => {
          const navData = [];
          const navSelectors = ['nav a', 'header a', '[role="navigation"] a'];
          for (const sel of navSelectors) {
            for (const el of document.querySelectorAll(sel)) {
              const label = (el.textContent || '').trim().replace(/\s+/g, ' ');
              const href = el.getAttribute('href') || '';
              // Skip tiny / icon-only links + anchors:
              if (label.length < 2 || label.length > 40) continue;
              if (href.startsWith('#')) continue;
              navData.push({ label, href });
            }
            if (navData.length > 0) break;
          }
          const footerEl = document.querySelector('footer, [role="contentinfo"], [class*="footer"]');
          const footerText = footerEl ? (footerEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
          return { navData, footerText };
        });

        // Merge nav items (dedupe by label):
        for (const item of pageData.navData || []) {
          if (!out.navItems.find(existing => existing.label === item.label)) {
            out.navItems.push(item);
          }
          if (out.navItems.length >= 12) break;
        }

        if (pageData.footerText && !out.footerText) {
          out.footerText = pageData.footerText.slice(0, 4000);
        }

        // Best-effort reference screenshot for the home page only — full-page
        // screenshots are expensive and we don't need every variant.
        if (!subPath && opts.refScreenshotPath) {
          try {
            await page.screenshot({ path: opts.refScreenshotPath, fullPage: false });
            out.referencePages.push({ url, screenshot: opts.refScreenshotPath });
          } catch (_) {}
        }
      } catch (err) {
        // Skip pages that fail; this is best-effort.
        console.log(`[BrandExtract]   crawl miss ${url}: ${err.message.split('\n')[0]}`);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[BrandExtract] multi-page crawl failed: ${err.message}`);
    return out;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  // Pull regulatory phrases out of the concatenated footer text:
  const ft = out.footerText || '';
  const fdicMatch = ft.match(/Member\s+FDIC\.?(?:\s+Equal\s+Housing\s+(?:Lender|Opportunity)\.?)?/i);
  if (fdicMatch) out.disclosures.push(fdicMatch[0].replace(/\s+/g, ' ').trim());
  const equalHousingMatch = ft.match(/Equal\s+Housing\s+(?:Lender|Opportunity)\.?/i);
  if (equalHousingMatch && !out.disclosures.find(d => /Equal\s+Housing/i.test(d))) {
    out.disclosures.push(equalHousingMatch[0].replace(/\s+/g, ' ').trim());
  }
  const nmlsMatch = ft.match(/NMLS(?:R|S)?\s*(?:ID|#)?\s*[:#]?\s*(\d{5,8})/i);
  if (nmlsMatch) out.nmlsId = nmlsMatch[0].replace(/\s+/g, ' ').trim();
  const copyrightMatch = ft.match(/©\s*(?:\d{4}\s*[-\u2013]\s*)?\d{4}\s+[A-Z][\w\s&,.'-]{4,80}/);
  if (copyrightMatch) out.copyright = copyrightMatch[0].replace(/\s+/g, ' ').trim();

  return out;
}

/**
 * Load a hand-curated brand reference file (`inputs/brand-references/<slug>.md`)
 * and parse out: nav items, hero patterns, footer disclosures, transaction
 * feed examples, masking pattern, motifs. Returns an object MATCHING the
 * brand profile schema additions, or null when no file exists. The caller
 * merges this on top of the auto-crawled data so curated facts win.
 */
function loadBrandReferenceFile(slug) {
  if (!slug) return null;
  const refPath = path.resolve(PROJECT_ROOT, 'inputs', 'brand-references', `${slug}.md`);
  if (!fs.existsSync(refPath)) return null;
  let md;
  try { md = fs.readFileSync(refPath, 'utf8'); }
  catch (_) { return null; }

  const out = {
    nav: { items: [] },
    hero: { patterns: [] },
    footer: { disclosures: [], copyright: null, nmlsId: null },
    transactionFeedExamples: [],
    masking: null,
    motifs: [],
    _source: 'brand-references',
    _refPath: path.relative(PROJECT_ROOT, refPath),
  };

  // Each H2 block becomes a key. We use simple split-by-heading parsing —
  // these files are short and human-curated so robustness > cleverness.
  const sections = {};
  let currentSection = '_preamble';
  for (const line of md.split('\n')) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      currentSection = h2[1].trim().toLowerCase();
      sections[currentSection] = [];
    } else if (sections[currentSection]) {
      sections[currentSection].push(line);
    }
  }
  const bulletsOf = (heading) => {
    const lines = sections[heading] || [];
    return lines
      .filter(l => /^\s*-\s+/.test(l))
      .map(l => l.replace(/^\s*-\s+/, '').trim())
      .filter(Boolean);
  };

  // Nav items: the file convention is a single bullet line `Item 1 | Item 2 | ...`.
  const navLines = bulletsOf('nav (online banking, post-login)');
  if (navLines.length > 0) {
    out.nav.items = navLines[0].split('|').map(s => s.trim()).filter(Boolean).map(label => ({ label, href: null }));
  }

  out.hero.patterns = bulletsOf('hero / hero-area copy patterns');

  // Footer disclosures: each bullet is a verbatim disclosure string.
  const footerLines = bulletsOf('footer disclosures (verbatim — do not paraphrase)') ||
    bulletsOf('footer disclosures (verbatim - do not paraphrase)');
  for (const line of footerLines) {
    const cleaned = line.replace(/^["']|["']$/g, ''); // strip surrounding quotes
    if (/©|copyright/i.test(cleaned) && !out.footer.copyright) {
      out.footer.copyright = cleaned;
    } else if (/NMLS/i.test(cleaned) && !out.footer.nmlsId) {
      out.footer.nmlsId = cleaned;
    } else {
      out.footer.disclosures.push(cleaned);
    }
  }

  out.transactionFeedExamples = bulletsOf('transaction feed format');

  const maskLines = bulletsOf('account number masks');
  if (maskLines.length > 0) {
    // Use the first bullet as the canonical pattern label.
    out.masking = { pattern: maskLines[0], examples: maskLines };
  }

  out.motifs = bulletsOf('brand motifs');

  return out;
}

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
      imageUrl: 'https absolute URL for horizontal/wordmark logo <img> from raw data, or null',
      iconUrl: 'https absolute URL for square icon <img> from raw data, or null',
      shellBg: 'rgba() or #hex background for optional logo chip/container, or null',
      shellBorder: '#hex or rgba border color for optional logo chip/container, or null',
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
    `- logo.imageUrl / logo.iconUrl: when RAW BRAND DATA includes logoImageUrl or iconImageUrl, copy those exact https URLs into the profile (required for real logo rendering). If raw logos[] has src fields, prefer SVG or PNG wordmark for imageUrl.\n` +
    `- logo.shellBg / logo.shellBorder: optional. Do not force contrast overrides; keep null unless explicitly present in source styling.\n` +
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

function _bfTypeWeight(t) {
  const x = String(t || '').toLowerCase();
  if (x === 'logo') return 4;
  if (x === 'symbol' || x === 'mark') return 3;
  if (x === 'other') return 2;
  if (x === 'icon') return 1;
  return 2;
}

function _bfFormatWeight(f) {
  const g = String((f && f.format) || '').toLowerCase();
  if (g === 'svg') return 5;
  if (g === 'png') return 4;
  if (g === 'webp') return 3;
  if (g === 'jpeg' || g === 'jpg') return 2;
  return 1;
}

function _bfThemeWeight(src, isWordmark) {
  const s = String(src || '').toLowerCase();
  if (!s) return 0;
  // For host apps that are frequently light-themed, prefer dark/neutral wordmarks.
  if (/\/theme\/dark\//.test(s)) return isWordmark ? 4 : 2;
  if (/\/theme\/light\//.test(s)) return isWordmark ? -4 : -1;
  return isWordmark ? 2 : 1;
}

function _isThemeUrl(src, theme) {
  return new RegExp(`/theme/${theme}/`, 'i').test(String(src || ''));
}

function _replaceThemeInUrl(src, fromTheme, toTheme) {
  return String(src || '').replace(new RegExp(`/theme/${fromTheme}/`, 'i'), `/theme/${toTheme}/`);
}

function _buildLogoSrcSet(rawData) {
  const set = new Set();
  for (const row of rawData?.logos || []) {
    const src = String(row?.src || '');
    if (src) set.add(src);
  }
  return set;
}

function _pickBestThemeVariant(rawData, { theme, preferIcon = false } = {}) {
  let best = { score: -1, src: null };
  const targetTheme = String(theme || '').toLowerCase();
  for (const row of rawData?.logos || []) {
    const src = String(row?.src || '');
    if (!src || !_isThemeUrl(src, targetTheme)) continue;
    const type = String(row?.brandfetchType || '').toLowerCase();
    const isIcon = type === 'icon';
    const isWordmark = !isIcon;
    const score =
      _bfTypeWeight(type) * 20 +
      _bfFormatWeight({ format: row?.format }) +
      _bfThemeWeight(src, isWordmark) +
      (preferIcon ? (isIcon ? 5 : -2) : (isWordmark ? 5 : -2));
    if (score > best.score) best = { score, src };
  }
  return best.src || null;
}

function enforceLogoContrast(profile, rawData) {
  if (!profile || !profile.logo || !rawData) return;
  const mode = String(profile.mode || '').toLowerCase();
  const logo = profile.logo;
  const srcSet = _buildLogoSrcSet(rawData);
  const currentImage = String(logo.imageUrl || '');
  const currentIcon = String(logo.iconUrl || '');

  if (mode === 'light') {
    if (currentImage && _isThemeUrl(currentImage, 'light')) {
      let replacement = null;
      const candidateBySwap = _replaceThemeInUrl(currentImage, 'light', 'dark');
      if (srcSet.has(candidateBySwap)) replacement = candidateBySwap;
      if (!replacement) replacement = _pickBestThemeVariant(rawData, { theme: 'dark', preferIcon: false });
      if (replacement) {
        logo.darkImageUrl = replacement;
      }
    }
    if (currentIcon && _isThemeUrl(currentIcon, 'light')) {
      let replacement = null;
      const candidateBySwap = _replaceThemeInUrl(currentIcon, 'light', 'dark');
      if (srcSet.has(candidateBySwap)) replacement = candidateBySwap;
      if (!replacement) replacement = _pickBestThemeVariant(rawData, { theme: 'dark', preferIcon: true });
      if (replacement) {
        logo.darkIconUrl = replacement;
      }
    }
  }
}

/** Pick best wordmark + icon URLs (Brandfetch returns many formats; first 3 were often wrong). */
function pickBrandfetchLogoUrls(data) {
  let bestWord = { score: -1, src: null };
  let bestIcon = { score: -1, src: null };
  for (const logo of data.logos || []) {
    const tw = _bfTypeWeight(logo.type);
    const isIcon = String(logo.type || '').toLowerCase() === 'icon';
    const isWordmark = !isIcon;
    for (const fmt of logo.formats || []) {
      if (!fmt.src || typeof fmt.src !== 'string' || !/^https?:\/\//i.test(fmt.src)) continue;
      const score = tw * 20 + _bfFormatWeight(fmt) + _bfThemeWeight(fmt.src, isWordmark);
      if (isIcon) {
        if (score > bestIcon.score) bestIcon = { score, src: fmt.src };
      } else if (score > bestWord.score) {
        bestWord = { score, src: fmt.src };
      }
    }
  }
  const logoImageUrl = bestWord.src || bestIcon.src || null;
  const iconImageUrl = bestIcon.src || null;
  return { logoImageUrl, iconImageUrl };
}

function brandfetchToRaw(data) {
  const colors = (data.colors || []).map(c => ({
    hex:  c.hex,
    type: c.type,
    brightness: c.brightness,
  }));

  const fonts = (data.fonts || []).map(f => ({
    name:   f.name,
    type:   f.type,
    origin: f.origin,
    url:    f.cssUrl || null,
  }));

  const { logoImageUrl, iconImageUrl } = pickBrandfetchLogoUrls(data);

  const logoRows = [];
  for (const logo of data.logos || []) {
    for (const fmt of logo.formats || []) {
      if (!fmt.src || !/^https?:\/\//i.test(fmt.src)) continue;
      logoRows.push({
        brandfetchType: logo.type,
        src:            fmt.src,
        format:         fmt.format,
        width:          fmt.width,
        height:         fmt.height,
      });
    }
  }
  logoRows.sort((a, b) => {
    const da = _bfTypeWeight(a.brandfetchType) * 10 + _bfFormatWeight(a);
    const db = _bfTypeWeight(b.brandfetchType) * 10 + _bfFormatWeight(b);
    return db - da;
  });

  return {
    source:         'brandfetch',
    name:           data.name || data.domain,
    domain:         data.domain,
    description:    data.description,
    colors,
    fonts,
    logoImageUrl,
    iconImageUrl,
    logos:          logoRows.slice(0, 12),
  };
}

function mergeFetchedLogoUrls(profile, rawData) {
  if (!profile || !rawData) return;
  if (!profile.logo || typeof profile.logo !== 'object') profile.logo = {};
  if (rawData.logoImageUrl && !profile.logo.imageUrl) profile.logo.imageUrl = rawData.logoImageUrl;
  if (rawData.iconImageUrl && !profile.logo.iconUrl) profile.logo.iconUrl = rawData.iconImageUrl;
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
    writeRunMeta({ ok: false, skipped: true, slug, reason: 'plaid-default' });
    return null;
  }
  if (slug === 'unknown' && !url) {
    console.log(`[BrandExtract] Brand "unknown" with no URL — no extraction needed (using built-in defaults)`);
    writeRunMeta({ ok: false, skipped: true, slug, reason: 'unknown-no-url' });
    return null;
  }

  fs.mkdirSync(BRAND_DIR, { recursive: true });

  const siteRefPath = path.join(BRAND_DIR, 'site-reference.png');
  if (url) {
    await captureBrandSiteReferenceScreenshot(url, siteRefPath);
  }

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
    writeRunMeta({ ok: false, skipped: true, slug, domain, reason: 'no-brand-data' });
    return null;
  }

  // ── 3. Normalize with Claude Haiku ────────────────────────────────────────
  console.log(`[BrandExtract] Normalizing brand data with Claude Haiku...`);
  let profile;
  try {
    profile = await normalizeToBrandProfile(rawData, companyName, slug);
  } catch (err) {
    console.error(`[BrandExtract] Haiku normalization failed: ${err.message}`);
    writeRunMeta({ ok: false, skipped: true, slug, reason: 'normalize-failed', error: err.message });
    return null;
  }

  // Ensure required fields
  profile.$schema = 'brand-profile/v1';
  profile.name    = profile.name || companyName;
  profile.slug    = slug;
  profile._source = rawData.source;
  profile._extractedAt = new Date().toISOString();
  profile._extractDomain = domain;
  mergeFetchedLogoUrls(profile, rawData);
  if (!profile.logo || typeof profile.logo !== 'object') profile.logo = {};
  enforceLogoContrast(profile, rawData);

  // Compute host-banner recommendation so downstream build prompts can pick
  // a background that keeps the logo visible. Safe to re-run; it is pure data
  // and does not mutate other brand tokens.
  try {
    const { recommendHostBanner } = require('../utils/brand-contrast');
    profile.hostBanner = recommendHostBanner(profile);
    const hb = profile.hostBanner;
    console.log(
      `[BrandExtract] Host banner recommendation: bg=${hb.bg} logoTone=${hb.logoTone} ` +
        `(source=${hb.toneSource}${hb.contrastRatio ? `, contrast=${hb.contrastRatio}:1` : ''})` +
        `${hb.fallback ? ' [fallback-white]' : ''}`
    );
  } catch (e) {
    console.warn(`[BrandExtract] Could not compute host-banner recommendation: ${e.message}`);
  }

  // Multi-page crawl: nav items + footer disclosures + reference screenshots.
  // Skipped when BRAND_EXTRACT_DEEP_CRAWL=0 (e.g. CI runs that don't have
  // network access to the brand site).
  const deepCrawlEnabled = String(process.env.BRAND_EXTRACT_DEEP_CRAWL ?? '1').trim() !== '0';
  if (deepCrawlEnabled && url) {
    try {
      console.log(`[BrandExtract] Multi-page crawl: ${url} (+ sign-in / about / privacy / security)`);
      const crawl = await crawlAdditionalBrandPages(url, {
        refScreenshotPath: siteRefPath,
      });
      if (crawl.navItems.length > 0) {
        profile.nav = profile.nav || {};
        profile.nav.items = crawl.navItems;
      }
      if (crawl.disclosures.length > 0 || crawl.copyright || crawl.nmlsId) {
        profile.footer = profile.footer || {};
        if (crawl.disclosures.length > 0) profile.footer.disclosures = crawl.disclosures;
        if (crawl.copyright) profile.footer.copyright = crawl.copyright;
        if (crawl.nmlsId) profile.footer.nmlsId = crawl.nmlsId;
      }
      if (crawl.referencePages.length > 0) {
        profile.referencePages = crawl.referencePages.map(p => ({
          url: p.url,
          screenshot: path.relative(OUT_DIR, p.screenshot),
        }));
      }
      console.log(
        `[BrandExtract]   crawl summary: ${crawl.navItems.length} nav item(s), ` +
        `${crawl.disclosures.length} disclosure(s)` +
        `${crawl.copyright ? ', ©' : ''}${crawl.nmlsId ? ', NMLS' : ''}`
      );
    } catch (e) {
      console.warn(`[BrandExtract]   multi-page crawl skipped: ${e.message}`);
    }
  } else if (!deepCrawlEnabled) {
    console.log('[BrandExtract] BRAND_EXTRACT_DEEP_CRAWL=0 — skipping multi-page crawl.');
  }

  // Brand-reference file MERGE — hand-curated facts from inputs/brand-references/<slug>.md
  // override anything the auto-crawl produced (so a stale crawl can't poison
  // the prompt with wrong nav items).
  const refFile = loadBrandReferenceFile(slug);
  if (refFile) {
    console.log(`[BrandExtract] Loaded brand-reference file: ${refFile._refPath}`);
    if (refFile.nav && refFile.nav.items && refFile.nav.items.length > 0) {
      profile.nav = profile.nav || {};
      profile.nav.items = refFile.nav.items;
      profile.nav._source = 'brand-references';
    }
    if (refFile.hero && refFile.hero.patterns && refFile.hero.patterns.length > 0) {
      profile.hero = { patterns: refFile.hero.patterns };
    }
    if (refFile.footer) {
      profile.footer = profile.footer || {};
      if (refFile.footer.disclosures && refFile.footer.disclosures.length > 0) {
        profile.footer.disclosures = refFile.footer.disclosures;
      }
      if (refFile.footer.copyright) profile.footer.copyright = refFile.footer.copyright;
      if (refFile.footer.nmlsId) profile.footer.nmlsId = refFile.footer.nmlsId;
      profile.footer._source = 'brand-references';
    }
    if (refFile.transactionFeedExamples && refFile.transactionFeedExamples.length > 0) {
      profile.transactionFeedExamples = refFile.transactionFeedExamples;
    }
    if (refFile.masking) profile.masking = refFile.masking;
    if (refFile.motifs && refFile.motifs.length > 0) profile.motifs = refFile.motifs;
  }

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  console.log(`[BrandExtract] Wrote ${path.relative(PROJECT_ROOT, profilePath)} (${profile.name}, mode: ${profile.mode})`);
  writeRunMeta({
    ok: true,
    slug,
    source: rawData.source,
    profileFile: path.relative(OUT_DIR, profilePath),
    domain,
    siteReferencePng: fs.existsSync(siteRefPath) ? path.relative(OUT_DIR, siteRefPath) : null,
  });

  return profile;
}

/** Lowercase hostname without leading www. */
function normalizeBrandDomain(d) {
  return String(d || '')
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/**
 * Same slug resolution as main() (demo-script persona + optional CLI --brand=).
 */
function getBrandSlugForExtract() {
  const { forcedSlug, forcedUrl } = parseArgs();
  const { company, brandUrl } = loadContext({ quiet: true });
  const url = forcedUrl || brandUrl;
  let derivedCompany = company || forcedSlug;
  if (!derivedCompany && url) {
    try {
      derivedCompany = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    } catch (_) {}
  }
  const companyName = derivedCompany || 'Unknown';
  return forcedSlug || toSlug(companyName);
}

/**
 * Same marketing-domain resolution as main() (Brand URL line, inferred prompt URL, or guessDomain).
 */
function getResolvedBrandDomain() {
  const { forcedUrl, forcedSlug } = parseArgs();
  const { company, brandUrl } = loadContext({ quiet: true });
  const url = forcedUrl || brandUrl;
  let derivedCompany = company || forcedSlug;
  if (!derivedCompany && url) {
    try {
      derivedCompany = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    } catch (_) {}
  }
  const companyName = derivedCompany || 'Unknown';
  const slug = forcedSlug || toSlug(companyName);
  if (slug === 'unknown' && !url) return null;

  return url
    ? new URL(url).hostname.replace(/^www\./, '')
    : guessDomain(companyName);
}

/** Domain last written by brand-extract for this slug (null if missing / unreadable). */
function readStoredBrandExtractDomain(slug) {
  if (!slug || slug === 'plaid') return null;
  const profilePath = path.join(BRAND_DIR, `${slug}.json`);
  if (!fs.existsSync(profilePath)) return null;
  try {
    const p = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (p._extractDomain && typeof p._extractDomain === 'string') return p._extractDomain;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * When the pipeline resumes after brand-extract (e.g. --from=build), compare the prompt/script
 * marketing domain to brand/<slug>._extractDomain; run brand-extract if missing or different.
 *
 * @param {function(): Promise<void>} runBrandExtractStage  e.g. () => runStage('brand-extract', ...)
 */
async function maybeRefreshBrandIfPromptDomainChanged(runBrandExtractStage) {
  const slug = getBrandSlugForExtract();
  if (!slug || slug === 'plaid') return;

  const expected = getResolvedBrandDomain();
  if (!expected) {
    console.log('[BrandExtract] Pre-build check: could not resolve brand domain from prompt/script — skipping refresh');
    return;
  }

  const stored = readStoredBrandExtractDomain(slug);
  const ne = normalizeBrandDomain(expected);
  const ns = normalizeBrandDomain(stored);
  if (stored == null || ne !== ns) {
    console.log(
      `[BrandExtract] Pre-build refresh: prompt domain "${ne}" vs stored "${stored == null ? '(no profile)' : ns}" — re-running brand-extract`
    );
    await runBrandExtractStage();
  } else {
    console.log(`[BrandExtract] Pre-build check: profile domain matches prompt (${ne})`);
  }
}

module.exports = {
  main,
  normalizeBrandDomain,
  getBrandSlugForExtract,
  getResolvedBrandDomain,
  readStoredBrandExtractDomain,
  maybeRefreshBrandIfPromptDomainChanged,
};

if (require.main === module) {
  main().catch(err => {
    console.error('[BrandExtract] Fatal:', err.message);
    process.exit(1);
  });
}
