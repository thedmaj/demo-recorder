'use strict';

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writePipelineRunContext } = require('../utils/run-context');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function toSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeCompanyName(input, website) {
  const provided = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
  if (provided) return provided;
  if (website) {
    try {
      const first = new URL(String(website)).hostname.replace(/^www\./i, '').split('.')[0] || '';
      if (first) {
        return first
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (m) => m.toUpperCase());
      }
    } catch (_) {}
  }
  return '';
}

function normalizeWebsite(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(value);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('Website must be an http(s) URL');
  return parsed.toString();
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readBrandProfileFromMeta(runDir) {
  const meta = safeReadJson(path.join(runDir, 'brand-extract.json'));
  const rel = meta && typeof meta.profileFile === 'string' ? meta.profileFile : '';
  if (rel) {
    const profilePath = path.join(runDir, rel);
    const profile = safeReadJson(profilePath);
    if (profile && typeof profile === 'object') return { profile, profilePath };
  }
  const brandDir = path.join(runDir, 'artifacts', 'brand');
  if (!fs.existsSync(brandDir)) return { profile: null, profilePath: null };
  const candidates = fs.readdirSync(brandDir)
    .filter((f) => f.endsWith('.json') && f !== 'brand-extract.json')
    .sort();
  for (const file of candidates) {
    const abs = path.join(brandDir, file);
    const profile = safeReadJson(abs);
    if (profile && typeof profile === 'object') return { profile, profilePath: abs };
  }
  return { profile: null, profilePath: null };
}

function runBrandExtract(runDir, companyName, website) {
  const script = path.join(PROJECT_ROOT, 'scripts', 'scratch', 'scratch', 'brand-extract.js');
  const args = [script];
  if (companyName) args.push(`--brand=${toSlug(companyName)}`);
  if (website) args.push(`--url=${website}`);
  const child = spawnSync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PIPELINE_RUN_DIR: runDir,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (child.status !== 0) {
    const errText = [child.stderr, child.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`brand-extract failed during clone${errText ? `: ${errText}` : ''}`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildColorReplacementPairs(oldProfile, newProfile) {
  const keys = [
    'accentCta',
    'bgPrimary',
    'surfaceCard',
    'surfaceCardBorder',
    'navBg',
    'navAccentStripe',
  ];
  const pairs = [];
  const oldColors = oldProfile && oldProfile.colors && typeof oldProfile.colors === 'object' ? oldProfile.colors : {};
  const newColors = newProfile && newProfile.colors && typeof newProfile.colors === 'object' ? newProfile.colors : {};
  for (const key of keys) {
    const oldVal = typeof oldColors[key] === 'string' ? oldColors[key].trim() : '';
    const newVal = typeof newColors[key] === 'string' ? newColors[key].trim() : '';
    if (!oldVal || !newVal || oldVal === newVal) continue;
    pairs.push([oldVal, newVal]);
  }
  return pairs;
}

function injectBrandCloneOverrides(html, newProfile, newCompanyName) {
  const colors = newProfile && newProfile.colors && typeof newProfile.colors === 'object' ? newProfile.colors : {};
  const logo = newProfile && newProfile.logo && typeof newProfile.logo === 'object' ? newProfile.logo : {};
  const accent = colors.accentCta || '#00A67E';
  const navBg = colors.navBg || '#ffffff';
  const bodyBg = colors.bgPrimary || '#f8fafc';
  const logoShellBg = logo.shellBg || 'rgba(15,23,42,0.06)';
  const logoShellBorder = logo.shellBorder || 'rgba(15,23,42,0.16)';
  const overrideTag = `
<style id="brand-clone-overrides">
:root{
  --brand-clone-accent:${accent};
  --brand-clone-nav-bg:${navBg};
  --brand-clone-body-bg:${bodyBg};
  --brand-clone-logo-shell-bg:${logoShellBg};
  --brand-clone-logo-shell-border:${logoShellBorder};
}
body,.chase-body,.host-app-main,.app-shell-main{background:var(--brand-clone-body-bg) !important;}
[data-testid="host-bank-logo-shell"],[data-testid^="host-bank-logo-shell-"]{
  background:var(--brand-clone-logo-shell-bg) !important;
  border-color:var(--brand-clone-logo-shell-border) !important;
}
button[class*="btn-primary"], .btn-primary, [data-testid="link-external-account-btn"]{
  background:var(--brand-clone-accent) !important;
  border-color:var(--brand-clone-accent) !important;
}
.chase-nav,.host-nav,.app-top-nav{
  background:var(--brand-clone-nav-bg) !important;
}
</style>
`;
  let next = html.replace(/<style id="brand-clone-overrides">[\s\S]*?<\/style>/i, '');
  next = next.includes('</head>') ? next.replace('</head>', `${overrideTag}\n</head>`) : `${next}\n${overrideTag}`;
  // Keep token payload updates deterministic for link/token/create snippets.
  next = next.replace(/("client_name"\s*:\s*")[^"]*(")/g, `$1${newCompanyName}$2`);
  next = next.replace(/(client_name\s*:\s*')[^']*(')/g, `$1${newCompanyName}$2`);
  next = next.replace(/(client_name\s*:\s*")[^"]*(")/g, `$1${newCompanyName}$2`);
  return next;
}

function patchHtmlBranding(filePath, oldProfile, newProfile, newCompanyName) {
  if (!fs.existsSync(filePath)) return false;
  let html = fs.readFileSync(filePath, 'utf8');
  const oldLogo = oldProfile && oldProfile.logo && typeof oldProfile.logo === 'object' ? oldProfile.logo : {};
  const newLogo = newProfile && newProfile.logo && typeof newProfile.logo === 'object' ? newProfile.logo : {};

  const urlPairs = [
    [oldLogo.imageUrl, newLogo.imageUrl],
    [oldLogo.iconUrl, newLogo.iconUrl],
  ].filter(([from, to]) => typeof from === 'string' && from.trim() && typeof to === 'string' && to.trim() && from !== to);

  for (const [from, to] of urlPairs) {
    html = html.replace(new RegExp(escapeRegExp(from), 'g'), to);
  }

  const colorPairs = buildColorReplacementPairs(oldProfile, newProfile);
  for (const [from, to] of colorPairs) {
    html = html.replace(new RegExp(escapeRegExp(from), 'gi'), to);
  }

  html = injectBrandCloneOverrides(html, newProfile, newCompanyName);
  fs.writeFileSync(filePath, html, 'utf8');
  return true;
}

function patchIngestedInputs(runDir, companyName, website) {
  const file = path.join(runDir, 'ingested-inputs.json');
  const parsed = safeReadJson(file);
  if (!parsed || typeof parsed !== 'object') return false;
  const texts = Array.isArray(parsed.texts) ? parsed.texts : [];
  let promptEntry = texts.find((t) => /prompt\.txt$/i.test(String(t && t.filename || '')));
  if (!promptEntry) {
    promptEntry = { filename: 'prompt.txt', content: '' };
    texts.push(promptEntry);
  }
  let content = String(promptEntry.content || '');
  const companyLine = `Company: ${companyName}`;
  const brandUrlLine = website ? `Brand URL: ${website}` : '';
  if (/^\s*Company(?:\s+name)?\s*:/im.test(content)) {
    content = content.replace(/^\s*Company(?:\s+name)?\s*:.+$/im, companyLine);
  } else {
    content = `${companyLine}\n${content}`.trim();
  }
  if (brandUrlLine) {
    if (/^\s*Brand\s+URL\s*:/im.test(content)) {
      content = content.replace(/^\s*Brand\s+URL\s*:.+$/im, brandUrlLine);
    } else {
      content = `${brandUrlLine}\n${content}`.trim();
    }
  }
  promptEntry.content = content;
  if (typeof parsed.rawPrompt === 'string') parsed.rawPrompt = content;
  if (typeof parsed.prompt === 'string') parsed.prompt = content;
  parsed.texts = texts;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  return true;
}

async function runBrandClone(opts = {}) {
  const runDir = path.resolve(String(opts.runDir || '').trim());
  if (!runDir) throw new Error('runDir is required');
  if (!fs.existsSync(runDir)) throw new Error(`runDir not found: ${runDir}`);

  const website = opts.website ? normalizeWebsite(opts.website) : '';
  const companyName = normalizeCompanyName(opts.companyName, website);
  if (!companyName) throw new Error('companyName is required when website does not infer one');

  const before = readBrandProfileFromMeta(runDir);
  runBrandExtract(runDir, companyName, website);
  const after = readBrandProfileFromMeta(runDir);
  if (!after.profile) throw new Error('brand-clone could not load new brand profile');

  patchIngestedInputs(runDir, companyName, website);
  writePipelineRunContext(runDir, {
    company: companyName,
    persona: { company: companyName },
    brand: {
      company: companyName,
      website: website || null,
      profileFile: after.profilePath ? path.relative(runDir, after.profilePath) : null,
    },
  });

  const htmlTargets = [
    path.join(runDir, 'scratch-app', 'index.html'),
    path.join(runDir, 'artifacts', 'build', 'scratch-app', 'index.html'),
  ];
  let patchedCount = 0;
  for (const file of htmlTargets) {
    if (patchHtmlBranding(file, before.profile, after.profile, companyName)) patchedCount++;
  }

  const report = {
    ok: true,
    at: new Date().toISOString(),
    runDir,
    sourceRunId: opts.sourceRunId || null,
    companyName,
    website: website || null,
    patchedHtmlFiles: patchedCount,
    oldBrandProfile: before.profilePath ? path.relative(runDir, before.profilePath) : null,
    newBrandProfile: after.profilePath ? path.relative(runDir, after.profilePath) : null,
  };
  fs.writeFileSync(path.join(runDir, 'brand-clone.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [k, ...rest] = arg.slice(2).split('=');
    out[k] = rest.length ? rest.join('=') : 'true';
  }
  return out;
}

module.exports = { runBrandClone };

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const result = await runBrandClone({
      runDir: args['run-dir'] || process.env.PIPELINE_RUN_DIR,
      companyName: args.company,
      website: args.website || args.url,
      sourceRunId: args['source-run-id'],
    });
    console.log(`[brand-clone] complete for ${result.companyName}`);
  })().catch((err) => {
    console.error(`[brand-clone] failed: ${err.message}`);
    process.exit(1);
  });
}
