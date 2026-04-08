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
async function handleApiRoute(req, res, urlPath) {
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
          explicitMode: body.linkMode || body.link_mode,
          promptText: JSON.stringify(body || {}),
        });
        const linkModeAdapter = getLinkModeAdapter(resolvedLinkMode);
        const products = body.products;
        const isCra = (
          (Array.isArray(products) && products.some((p) => /cra|consumer_report/i.test(String(p)))) ||
          /cra|consumer[_\s-]?report|income[_\s-]?insights|check/i.test(String(body.productFamily || body.product_family || '')) ||
          String(body.credentialScope || body.credential_scope || '').toLowerCase() === 'cra'
        );
        const baseOpts = {
          ...body,
          products:             body.products,
          clientName:           body.clientName || body.client_name,
          userId:               body.userId || body.user_id,
          phoneNumber:          body.phoneNumber || body.phone_number || null,
          checkUserIdentity:    body.checkUserIdentity || body.check_user_identity || body.consumer_report_user_identity || null,
          linkCustomizationName: body.linkCustomizationName || body.link_customization_name,
          productFamily:        body.productFamily || body.product_family || null,
          credentialScope:      body.credentialScope || body.credential_scope || null,
          linkMode:             resolvedLinkMode,
          hosted_link:          body.hosted_link && typeof body.hosted_link === 'object' ? body.hosted_link : undefined,
        };
        const modeScopedOpts = linkModeAdapter.prepareCreateLinkTokenBody(baseOpts);
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
      const handled = await handleApiRoute(req, res, urlPath);
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

module.exports = { startServer };
