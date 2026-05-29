/**
 * app-server.js
 *
 * Lightweight HTTP server that serves the scratch-app/ directory for Playwright
 * recording sessions. Uses only Node.js built-ins — no npm dependencies.
 *
 * When PLAID_LINK_LIVE=true, also handles POST /api/* routes for the Plaid
 * sandbox backend (link token creation, token exchange, auth, identity, signal).
 *
 * Exports:
 *   startServer(port?)  → Promise<{ url: string, close: () => Promise<void> }>
 *
 * Port selection: tries the requested port (default 3737), then 3738, 3739, …
 * up to 10 additional attempts before giving up.
 *
 * Serve behaviour:
 *   POST /api/*     → Plaid backend proxy (only when PLAID_LINK_LIVE=true)
 *   GET /           → scratch-app/index.html  (text/html)
 *   GET /<path>     → scratch-app/<path>      (MIME type inferred from extension)
 *   Anything else   → 404
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { resolveMode, getLinkModeAdapter } = require('./link-mode');
const {
  sanitizeProductsForLinkTokenMix,
  ALLOWED_LINK_PRODUCTS,
} = require('./link-token-create-config');

// In-memory cache so we don't re-read link-token-create-config.json on every
// /api/create-link-token call. Keyed by absolute path. Invalidated by mtime.
const _linkTokenConfigCache = new Map();

/**
 * Load the research-phase `link-token-create-config.json` from the active run
 * directory, if present. Returns null when the file is missing or unreadable
 * (this is normal for ad-hoc apps run outside the orchestrator).
 *
 * @param {string|null} runDir Absolute path to PIPELINE_RUN_DIR.
 * @returns {{ products?: string[], suggestedClientRequest?: object, productFamily?: string }|null}
 */
function loadResearchLinkTokenConfig(runDir) {
  if (!runDir) return null;
  const cfgPath = path.join(runDir, 'link-token-create-config.json');
  try {
    const stat = fs.statSync(cfgPath);
    const cached = _linkTokenConfigCache.get(cfgPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const config = JSON.parse(raw);
    _linkTokenConfigCache.set(cfgPath, { mtimeMs: stat.mtimeMs, config });
    return config;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the products[] list that the Plaid /link/token/create call should
 * use, in priority order:
 *   1. Research stage's link-token-create-config.json (authoritative).
 *   2. HTML request body's products[] (only when no research config exists).
 *   3. Safe default ['auth', 'identity'].
 *
 * The resolved list is then sanitized against Plaid's product-mix rules. This
 * enforces the contract documented at /api/create-link-token in CLAUDE.md:
 *   "the pipeline build should not hardcode Plaid Products but leverage the
 *    proper and recommended parameters based on the research phase or indexed
 *    product knowledge."
 *
 * @param {{
 *   bodyProducts?: any[],
 *   researchConfig?: object|null,
 *   productFamilyHint?: string,
 * }} input
 * @returns {{
 *   products: string[],
 *   source: 'research-config'|'request-body'|'fallback-default',
 *   sanitization: { droppedCra: string[], droppedNonCraIncomeIncompatible: string[] }|null,
 *   driftDetected: boolean,
 * }}
 */
function resolveCreateLinkTokenProducts({ bodyProducts, researchConfig, productFamilyHint } = {}) {
  const bodyClean = Array.isArray(bodyProducts)
    ? bodyProducts
        .map((p) => String(p || '').trim().toLowerCase())
        .filter((p) => p && ALLOWED_LINK_PRODUCTS.has(p))
    : [];
  const researchClean =
    researchConfig && Array.isArray(researchConfig.products) && researchConfig.products.length
      ? researchConfig.products
          .map((p) => String(p || '').trim().toLowerCase())
          .filter((p) => p && ALLOWED_LINK_PRODUCTS.has(p))
      : [];

  let products;
  let source;
  let driftDetected = false;
  if (researchClean.length) {
    products = researchClean;
    source = 'research-config';
    if (bodyClean.length) {
      const same =
        bodyClean.length === researchClean.length &&
        bodyClean.every((p) => researchClean.includes(p));
      driftDetected = !same;
    }
  } else if (bodyClean.length) {
    products = bodyClean;
    source = 'request-body';
  } else {
    products = ['auth', 'identity'];
    source = 'fallback-default';
  }

  const family = String(
    productFamilyHint || (researchConfig && researchConfig.productFamily) || ''
  ).toLowerCase();
  const intent = /cra|consumer[_\s-]?report|income[_\s-]?insights/.test(family) ? 'cra' : 'auto';
  const mix = sanitizeProductsForLinkTokenMix(products, intent);
  const sanitization =
    mix.droppedCra.length || mix.droppedNonCraIncomeIncompatible.length
      ? {
          droppedCra: mix.droppedCra,
          droppedNonCraIncomeIncompatible: mix.droppedNonCraIncomeIncompatible,
        }
      : null;

  return { products: mix.products, source, sanitization, driftDetected };
}

/**
 * Merge research `suggestedClientRequest` fields into the live token request.
 * Products[] are handled separately by resolveCreateLinkTokenProducts.
 * @param {object} baseOpts
 * @param {object|null} researchConfig
 */
function mergeResearchLinkTokenRequest(baseOpts, researchConfig) {
  const suggested =
    researchConfig &&
    researchConfig.suggestedClientRequest &&
    typeof researchConfig.suggestedClientRequest === 'object'
      ? researchConfig.suggestedClientRequest
      : null;
  if (!suggested) return baseOpts;

  const merged = { ...baseOpts };
  if (!merged.consumer_report_permissible_purpose && suggested.consumer_report_permissible_purpose) {
    merged.consumer_report_permissible_purpose = suggested.consumer_report_permissible_purpose;
  }
  if (!merged.cra_options && suggested.cra_options) {
    merged.cra_options = suggested.cra_options;
  }
  if (!merged.credentialScope && !merged.credential_scope && suggested.credentialScope) {
    merged.credentialScope = suggested.credentialScope;
  }
  if (!merged.productFamily && !merged.product_family && suggested.productFamily) {
    merged.productFamily = suggested.productFamily;
  }
  if (!merged.country_codes && suggested.country_codes) {
    merged.country_codes = suggested.country_codes;
  }
  if (!merged.language && suggested.language) {
    merged.language = suggested.language;
  }
  if (!merged.user && suggested.user) {
    merged.user = suggested.user;
  }
  return merged;
}

// ── MIME type map (common assets used in demo apps) ──────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
};

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets');
const PLAID_LOGO_FALLBACK_MAP = {
  'plaid-logo-horizontal-black-white-background.png': 'Plaid-Logo horizontal black with white background.png',
  'plaid-logo-horizontal-white-text-transparent-background.png': 'plaid logo horizontal white text transparent background.png',
  'plaid-logo-vertical-white-text-transparent-background.png': 'Plaid vertical logo white text transparent background.png',
  'plaid-logo-text-white-background.png': 'plaid logo text white background.png',
  'plaid-logo-no-text-white-background.png': 'plaid logo no text white background.png',
  'plaid-logo-no-text-black-background.png': 'plaid logo no text black background.png',
};

// Default scratch-app/ directory (relative to the project root,
// which is three levels up from this utils/ file).
// Can be overridden by passing rootDir to startServer().
const DEFAULT_SCRATCH_APP_DIR = path.resolve(__dirname, '../../../scratch-app');

// Plaid backend (lazy-loaded only when PLAID_LINK_LIVE=true)
let _plaidBackend = null;
function getPlaidBackend() {
  if (!_plaidBackend) {
    _plaidBackend = require('./plaid-backend');
  }
  return _plaidBackend;
}

/**
 * Read the full request body as a string.
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Send a JSON response with CORS headers.
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} data
 */
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

/**
 * Handle POST /api/* routes for the Plaid backend.
 * Returns true if the request was handled, false otherwise.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} urlPath  Decoded URL path
 * @returns {Promise<boolean>}
 */
async function handleApiRoute(req, res, urlPath, context = {}) {
  // Only handle when live mode is enabled
  if (process.env.PLAID_LINK_LIVE !== 'true') return false;

  // Handle CORS preflight
  if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    });
    res.end();
    return true;
  }

  if (req.method !== 'POST' || !urlPath.startsWith('/api/')) return false;

  const plaid = getPlaidBackend();
  let body = {};
  try {
    const raw = await readBody(req);
    if (raw) body = JSON.parse(raw);
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }

  try {
    switch (urlPath) {
      case '/api/create-link-token': {
        const resolvedLinkMode = resolveMode({
          explicitMode: body.linkMode || body.link_mode || context.plaidLinkMode,
          promptText: JSON.stringify(body || {}),
        });
        const linkModeAdapter = getLinkModeAdapter(resolvedLinkMode);

        // Research-driven products: prefer the products[] resolved by the
        // research stage (link-token-create-config.json) over whatever the
        // generated HTML hardcoded. This implements the contract:
        //   "the pipeline build should not hardcode Plaid Products but
        //    leverage the proper and recommended parameters based on the
        //    research phase or indexed product knowledge."
        const runDir = context.runDir || process.env.PIPELINE_RUN_DIR || null;
        const researchConfig = loadResearchLinkTokenConfig(runDir);
        const productsResolution = resolveCreateLinkTokenProducts({
          bodyProducts: body.products,
          researchConfig,
          productFamilyHint: body.productFamily || body.product_family,
        });
        if (productsResolution.driftDetected) {
          console.warn(
            `[app-server] /api/create-link-token: hardcoded HTML products [${(body.products || []).join(', ')}] differ from research config [${(researchConfig && researchConfig.products || []).join(', ')}] — using research config.`
          );
        }
        if (productsResolution.sanitization) {
          const s = productsResolution.sanitization;
          console.warn(
            `[app-server] /api/create-link-token: product-mix sanitization → [${productsResolution.products.join(', ')}] ` +
            `(source=${productsResolution.source}, dropped=${[...s.droppedCra, ...s.droppedNonCraIncomeIncompatible].join(', ')})`
          );
        }
        const products = productsResolution.products;

        const isCra = (
          products.some((p) => /cra|consumer_report/i.test(String(p))) ||
          /cra|consumer[_\s-]?report|income[_\s-]?insights|check/i.test(String(body.productFamily || body.product_family || '')) ||
          String(body.credentialScope || body.credential_scope || '').toLowerCase() === 'cra'
        );
        const baseOpts = mergeResearchLinkTokenRequest({
          ...body,
          products,
          clientName:           body.clientName || body.client_name,
          userId:               body.userId || body.user_id,
          phoneNumber:          body.phoneNumber || body.phone_number || null,
          checkUserIdentity:    body.checkUserIdentity || body.check_user_identity || body.consumer_report_user_identity || null,
          linkCustomizationName: body.linkCustomizationName || body.link_customization_name,
          productFamily:        body.productFamily || body.product_family || (researchConfig && researchConfig.productFamily) || null,
          credentialScope:      body.credentialScope || body.credential_scope || null,
          linkMode:             resolvedLinkMode,
          runDir,
        }, researchConfig);
        const modeScopedOpts = linkModeAdapter.prepareCreateLinkTokenBody(baseOpts);
        modeScopedOpts.linkMode = resolvedLinkMode;
        if (body.plaid_user_id || body.plaidUserId) {
          modeScopedOpts.plaidCheckUserId = body.plaid_user_id || body.plaidUserId;
        }
        if (body.plaid_user_token || body.plaidUserToken) {
          modeScopedOpts.legacyUserToken = body.plaid_user_token || body.plaidUserToken;
        }
        const result = isCra
          ? await plaid.createConsumerReportLinkToken(modeScopedOpts)
          : await plaid.createLinkToken(modeScopedOpts);
        sendJson(res, 200, result);
        return true;
      }

      case '/api/exchange-public-token': {
        const result = await plaid.exchangePublicToken(body.public_token, {
          productFamily:   body.productFamily || body.product_family || null,
          credentialScope: body.credentialScope || body.credential_scope || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      case '/api/auth-get': {
        const result = await plaid.getAuth(body.access_token, {
          credentialScope: body.credentialScope || body.credential_scope || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      case '/api/identity-match': {
        const result = await plaid.getIdentityMatch(body.access_token, body.legal_name, {
          credentialScope: body.credentialScope || body.credential_scope || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      case '/api/signal-evaluate': {
        const result = await plaid.evaluateSignal(body.access_token, body.account_id, body.amount, {
          credentialScope: body.credentialScope || body.credential_scope || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      case '/api/plaid-request': {
        const result = await plaid.plaidRequest(body.endpoint, body.body || {}, {
          productFamily: body.productFamily || body.product_family || null,
          credentialScope: body.credentialScope || body.credential_scope || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      // Plaid Layer (real Web SDK): create a Layer session token. The generated host
      // app fetches this on launch, then Plaid.create({token}) + handler.open() +
      // handler.submit({phone_number}). Template defaults to PLAID_LAYER_TEMPLATE_ID
      // inside plaid-backend.createSessionToken. See plaid-layer-idv-onboarding skill.
      case '/api/create-session-token': {
        const result = await plaid.createSessionToken({
          client_user_id: body.client_user_id || body.clientUserId || null,
          template_id:    body.template_id || body.templateId || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      // Plaid Layer onSuccess exchange: returns identity + items (no separate
      // /item/public_token/exchange needed). See plaid-backend.userAccountSessionGet.
      case '/api/user-account-session-get': {
        const result = await plaid.userAccountSessionGet(body.public_token || body.publicToken);
        sendJson(res, 200, result);
        return true;
      }

      // Plaid Identity Verification (live IDV): create an IDV Link token. Requires a
      // published IDV template (PLAID_IDV_TEMPLATE_ID). The generated app opens this
      // via Plaid.create({token}).open(); onSuccess metadata.link_session_id is the
      // identity_verification_id. See plaid-identity-verification.md.
      case '/api/create-idv-link-token': {
        const result = await plaid.createIdvLinkToken({
          client_user_id: body.client_user_id || body.clientUserId || null,
          template_id:    body.template_id || body.templateId || null,
          client_name:    body.client_name || body.clientName || null,
        });
        sendJson(res, 200, result);
        return true;
      }

      // IDV result lookup after onSuccess / STATUS_UPDATED webhook.
      case '/api/identity-verification-get': {
        const result = await plaid.getIdentityVerification(
          body.identity_verification_id || body.identityVerificationId
        );
        sendJson(res, 200, result);
        return true;
      }

      default:
        sendJson(res, 404, { error: `Unknown API route: ${urlPath}` });
        return true;
    }
  } catch (err) {
    console.error(`[AppServer] API error (${urlPath}): ${err.message}`);
    sendJson(res, 500, { error: err.message });
    return true;
  }
}

/**
 * Return the content-type for a file path based on its extension.
 * Falls back to 'application/octet-stream' for unknown types.
 *
 * @param {string} filePath
 * @returns {string}
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function resolveLogoFallbackPath(relativePath, scratchDir) {
  const base = path.basename(String(relativePath || ''));
  if (!base || !/^plaid-logo-.*\.(png|jpg|jpeg|svg)$/i.test(base)) return null;
  const candidates = [
    path.join(scratchDir, base),
    path.join(ASSETS_DIR, base),
    path.join(ASSETS_DIR, PLAID_LOGO_FALLBACK_MAP[base] || ''),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      // best-effort candidate scan
    }
  }
  return null;
}

/**
 * Attempt to start an HTTP server on the given port.
 * Resolves with the net.Server instance on success.
 * Rejects with the error on any error other than EADDRINUSE.
 * Rejects with EADDRINUSE error when the port is already taken.
 *
 * @param {http.Server} server
 * @param {number} port
 * @returns {Promise<void>}
 */
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

/**
 * Start the scratch-app HTTP server.
 *
 * @param {number} [port=3737]  Preferred port. Will try up to 10 higher ports on EADDRINUSE.
 * @param {string} [rootDir]    Directory to serve. Defaults to project-root/scratch-app/.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startServer(port = 3737, rootDir) {
  const SCRATCH_APP_DIR = rootDir || DEFAULT_SCRATCH_APP_DIR;
  const runDirFromScratch = path.basename(SCRATCH_APP_DIR) === 'scratch-app'
    ? path.dirname(SCRATCH_APP_DIR)
    : null;
  let runPlaidLinkMode = null;
  try {
    const modeRunDir = runDirFromScratch || process.env.PIPELINE_RUN_DIR || null;
    if (modeRunDir) {
      const demoScriptPath = path.join(modeRunDir, 'demo-script.json');
      if (fs.existsSync(demoScriptPath)) {
        const parsed = JSON.parse(fs.readFileSync(demoScriptPath, 'utf8'));
        const mode = String(parsed && parsed.plaidLinkMode || '').trim().toLowerCase();
        if (mode === 'embedded' || mode === 'modal') runPlaidLinkMode = mode;
        if (!runPlaidLinkMode) {
          const flowMode = String(parsed?.plaidSandboxConfig?.plaidLinkFlow || '').trim().toLowerCase();
          if (flowMode === 'embedded' || flowMode === 'modal') runPlaidLinkMode = flowMode;
        }
      }
    }
  } catch (_) {}
  const apiContext = {
    runDir: runDirFromScratch || process.env.PIPELINE_RUN_DIR || null,
    plaidLinkMode: runPlaidLinkMode,
  };
  const server = http.createServer(async (req, res) => {
    // Strip query string and URL-decode
    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0]);
    } catch (_) {
      urlPath = '/';
    }

    // ── Plaid API routes (POST /api/*) — only when PLAID_LINK_LIVE=true ──
    try {
      const handled = await handleApiRoute(req, res, urlPath, apiContext);
      if (handled) return;
    } catch (err) {
      console.error(`[AppServer] Unhandled API error: ${err.message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      }
      return;
    }

    // ── Static file serving ──────────────────────────────────────────────

    // Map '/' → 'index.html'
    const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');

    // Prevent path traversal attacks
    const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(SCRATCH_APP_DIR, safePath);

    // Ensure the resolved path stays inside scratch-app/
    if (!filePath.startsWith(SCRATCH_APP_DIR + path.sep) && filePath !== SCRATCH_APP_DIR) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        const fallbackLogoPath = resolveLogoFallbackPath(relativePath, SCRATCH_APP_DIR);
        if (fallbackLogoPath) {
          fs.readFile(fallbackLogoPath, (fallbackErr, fallbackData) => {
            if (fallbackErr) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end(`Not found: ${urlPath}`);
              return;
            }
            res.writeHead(200, {
              'Content-Type': getMimeType(fallbackLogoPath),
              'Access-Control-Allow-Origin': '*',
            });
            res.end(fallbackData);
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not found: ${urlPath}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': getMimeType(filePath),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  });

  // Try the requested port, then up to 10 higher ports
  const MAX_ATTEMPTS = 11;
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidatePort = port + attempt;
    try {
      await tryListen(server, candidatePort);
      const url = `http://localhost:${candidatePort}`;
      console.log(`[AppServer] Started at ${url}`);
      return {
        url,
        close: () =>
          new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      };
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        lastError = err;
        // Try next port
        continue;
      }
      // Unexpected error — propagate immediately
      throw err;
    }
  }

  throw new Error(
    `[AppServer] Could not bind to any port in range ${port}–${port + MAX_ATTEMPTS - 1}: ${lastError.message}`
  );
}

module.exports = {
  startServer,
  // Exported for unit testing. These pure helpers encode the
  // "research-driven products, not LLM-hardcoded products" contract
  // implemented by /api/create-link-token.
  loadResearchLinkTokenConfig,
  mergeResearchLinkTokenRequest,
  resolveCreateLinkTokenProducts,
};
