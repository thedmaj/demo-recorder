'use strict';
/**
 * run-package.js
 *
 * Packaging helper for the centralized demo-app distribution layer. Produces
 * a redacted, publish-safe bundle of a single run directory that can be
 * committed into the `plaid-demo-apps` artifact repository.
 *
 * Modes:
 *   - 'publish' (default): whitelist-only copy, no `.env`, no research /
 *     log artifacts, writes `PUBLISH_MANIFEST.json`, runs secret sweep.
 *   - 'local':   broader copy (includes full scratch-app, brand, research)
 *     suitable for offline inspection. Still runs secret sweep. For now we
 *     keep this mode thin; the existing `dashboard/server.js`
 *     `buildRunAppPackage` function owns the ZIP-flavored local export.
 *
 * Secrets:
 *   Before returning success, we scan every file written into the output
 *   directory with `check-publish-safety.js`. Any match aborts the whole
 *   packaging attempt with a structured error that includes the offending
 *   relative path, line number, and pattern name.
 */

const fs = require('fs');
const path = require('path');

const { scanPaths } = require('./check-publish-safety');

// ---------------------------------------------------------------------------
// Allow-lists
// ---------------------------------------------------------------------------

// File / directory patterns that are ALWAYS safe to publish (relative to
// run dir). Globs are simple prefix / suffix matches — we intentionally
// avoid a full glob library to keep deps zero.
const PUBLISH_ALLOW = [
  { kind: 'dir',  rel: 'scratch-app' },
  { kind: 'file', rel: 'demo-script.json' },
  { kind: 'file', rel: 'pipeline-run-context.json' },
  { kind: 'file', rel: 'playwright/playwright-script.json' },
  { kind: 'file', rel: 'recording.mp4' },
  { kind: 'file', rel: 'recording-processed.mp4' },
  { kind: 'file', rel: 'demo-scratch.mp4' },
  { kind: 'file', rel: 'brand-extract.json' },
  { kind: 'file', rel: 'voiceover-manifest.json' },
  { kind: 'file', rel: 'sync-map.json' },
  { kind: 'file', rel: 'timing-contract.json' },
  { kind: 'dir',  rel: 'audio' },
];

// Files that MAY be published only when the caller opts in, e.g. `inputs/prompt.txt`.
const PUBLISH_OPT_IN = {
  'inputs/prompt.txt': 'includePrompt',
};

// Patterns that are NEVER published, independent of allow-list (defense in depth).
const PUBLISH_DENY_SUBSTRINGS = [
  '/artifacts/logs/',
  '/.env',
  'credentials',
  'research-notes.md',
  'product-context.json',
  '/frames/',
  '/qa-frames/',
  'qa-report-',
  'build-qa-diagnostics.json',
];

function matchesDeny(rel) {
  const norm = '/' + String(rel).replace(/\\/g, '/');
  return PUBLISH_DENY_SUBSTRINGS.some((sub) => norm.includes(sub));
}

function walkDir(absDir, onFile) {
  if (!fs.existsSync(absDir)) return;
  const queue = [absDir];
  while (queue.length) {
    const p = queue.shift();
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p)) queue.push(path.join(p, entry));
    } else if (st.isFile()) {
      onFile(p);
    }
  }
}

function copyAbs(srcAbs, destAbs) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function getRunMeta(runDir) {
  const manifest = readJsonSafe(path.join(runDir, 'run-manifest.json')) || {};
  const demoScript = readJsonSafe(path.join(runDir, 'demo-script.json')) || {};
  const ctx = readJsonSafe(path.join(runDir, 'pipeline-run-context.json')) || {};
  const latestQa = (() => {
    try {
      const candidates = fs
        .readdirSync(runDir)
        .filter((f) => /^qa-report-.*\.json$/.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(runDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const c of candidates) {
        const json = readJsonSafe(path.join(runDir, c.f));
        if (json && typeof json.overallScore === 'number') return json;
      }
    } catch (_) {}
    return null;
  })();
  return { manifest, demoScript, ctx, latestQa };
}

function buildPublishManifest(runDir, opts) {
  const { manifest, demoScript, ctx, latestQa } = getRunMeta(runDir);
  const toolVersion = (() => {
    try {
      const pkg = readJsonSafe(path.join(__dirname, '..', '..', '..', 'package.json'));
      return pkg && pkg.version ? `plaid-demo-recorder@${pkg.version}` : 'plaid-demo-recorder@unknown';
    } catch (_) {
      return 'plaid-demo-recorder@unknown';
    }
  })();
  return {
    runId: manifest.runId || path.basename(runDir),
    owner: opts.owner || manifest.owner || null,
    buildMode: manifest.buildMode || null,
    buildModeSource: manifest.buildModeSource || null,
    plaidLinkMode:
      (typeof demoScript.plaidLinkMode === 'string' && demoScript.plaidLinkMode) ||
      (ctx && typeof ctx.plaidLinkMode === 'string' && ctx.plaidLinkMode) ||
      null,
    qaScore: latestQa && typeof latestQa.overallScore === 'number' ? latestQa.overallScore : null,
    qaPassed: latestQa && typeof latestQa.passed === 'boolean' ? latestQa.passed : null,
    stepCount: Array.isArray(demoScript.steps) ? demoScript.steps.length : null,
    publishedAt: new Date().toISOString(),
    toolVersion,
    promptIncluded: !!opts.includePrompt,
    notes: opts.notes || null,
  };
}

function buildReadme(manifestObj, runDir) {
  const { demoScript } = getRunMeta(runDir);
  const persona = demoScript.persona && typeof demoScript.persona === 'object' ? demoScript.persona : {};
  const lines = [
    `# ${manifestObj.runId}`,
    '',
    `**Owner**: ${manifestObj.owner ? '@' + manifestObj.owner.login : 'unknown'}  `,
    `**Build mode**: ${manifestObj.buildMode || '-'}  `,
    `**Plaid Link mode**: ${manifestObj.plaidLinkMode || '-'}  `,
    `**QA score**: ${manifestObj.qaScore != null ? manifestObj.qaScore : '-'}  `,
    `**Published at**: ${manifestObj.publishedAt}  `,
    '',
  ];
  if (demoScript.product) lines.push(`**Product**: ${demoScript.product}`);
  if (persona.company) lines.push(`**Company**: ${persona.company}`);
  if (persona.role || persona.name) lines.push(`**Persona**: ${[persona.name, persona.role].filter(Boolean).join(' — ')}`);
  lines.push(
    '',
    '## Run this demo locally',
    '',
    'Copy this directory to your machine, then from the repo root:',
    '',
    '```bash',
    'npm run pipe -- open   # opens the dashboard',
    '```',
    '',
    '## Regenerate from the prompt',
    '',
    'If `inputs/prompt.txt` is included, copy it to `inputs/prompt.txt` in your',
    'clone of `plaid-demo-recorder` and run:',
    '',
    '```bash',
    'npm run pipe -- new --app-only',
    '```',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Publish mode
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PublishOptions
 * @property {string} runDir           Absolute path to the source run directory.
 * @property {string} destDir          Absolute path to the destination directory.
 * @property {object} [owner]          { login, name } stamped onto the manifest.
 * @property {boolean} [includePrompt] Copy `inputs/prompt.txt` alongside artifacts.
 * @property {boolean} [overwrite]     Remove destDir if it exists before copying.
 * @property {string} [notes]          Free-text note recorded in PUBLISH_MANIFEST.
 */

/**
 * Package a run for publication. Throws on any secret-sweep failure.
 *
 * @param {PublishOptions} options
 * @returns {{ destDir: string, manifest: object, files: string[] }}
 */
function publishPackage(options) {
  const {
    runDir,
    destDir,
    owner = null,
    includePrompt = false,
    overwrite = false,
    notes = null,
  } = options || {};
  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`publishPackage: runDir not found: ${runDir}`);
  }
  if (!destDir) throw new Error('publishPackage: destDir required');

  if (fs.existsSync(destDir)) {
    if (!overwrite) {
      throw new Error(`publishPackage: destDir already exists: ${destDir} (pass overwrite:true to replace)`);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const copied = [];

  for (const rule of PUBLISH_ALLOW) {
    const srcAbs = path.join(runDir, rule.rel);
    if (!fs.existsSync(srcAbs)) continue;
    if (rule.kind === 'file') {
      if (matchesDeny(rule.rel)) continue;
      copyAbs(srcAbs, path.join(destDir, rule.rel));
      copied.push(rule.rel);
    } else {
      walkDir(srcAbs, (abs) => {
        const rel = path.relative(runDir, abs);
        if (matchesDeny(rel)) return;
        copyAbs(abs, path.join(destDir, rel));
        copied.push(rel);
      });
    }
  }

  for (const [rel, flag] of Object.entries(PUBLISH_OPT_IN)) {
    if (!options[flag]) continue;
    const srcAbs = path.join(runDir, rel);
    if (!fs.existsSync(srcAbs)) continue;
    copyAbs(srcAbs, path.join(destDir, rel));
    copied.push(rel);
  }

  // .env.example (empty values) so anyone who downloads the bundle knows
  // which env vars to wire up. Never the real .env.
  const envExample = [
    '# Populate these values locally before running the demo.',
    '# DO NOT commit the populated .env — this publish bundle intentionally',
    '# has no secrets.',
    'PLAID_LINK_LIVE=false',
    'PLAID_ENV=sandbox',
    'PLAID_CLIENT_ID=',
    'PLAID_SANDBOX_SECRET=',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(destDir, '.env.example'), envExample, 'utf8');
  copied.push('.env.example');

  const manifest = buildPublishManifest(runDir, { owner, includePrompt, notes });
  fs.writeFileSync(
    path.join(destDir, 'PUBLISH_MANIFEST.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
  copied.push('PUBLISH_MANIFEST.json');

  const readme = buildReadme(manifest, runDir);
  fs.writeFileSync(path.join(destDir, 'README.md'), readme, 'utf8');
  copied.push('README.md');

  // Secret sweep (paranoid): scan every file we copied.
  const absFiles = copied.map((rel) => path.join(destDir, rel));
  const findings = scanPaths(absFiles, { rootDir: destDir });
  if (findings.length > 0) {
    fs.rmSync(destDir, { recursive: true, force: true });
    const err = new Error(
      `publishPackage: secret-sweep blocked publish (${findings.length} match${findings.length === 1 ? '' : 'es'}). First hit: ${findings[0].path}:${findings[0].line} [${findings[0].pattern}]`
    );
    err.code = 'PUBLISH_BLOCKED_SECRET';
    err.findings = findings;
    throw err;
  }

  return { destDir, manifest, files: copied };
}

module.exports = {
  PUBLISH_ALLOW,
  PUBLISH_OPT_IN,
  PUBLISH_DENY_SUBSTRINGS,
  matchesDeny,
  publishPackage,
  buildPublishManifest,
};
