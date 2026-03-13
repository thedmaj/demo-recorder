/**
 * mcp-clients.js
 *
 * REST API wrappers for external knowledge sources used by the Plaid demo pipeline.
 *
 * Exports:
 *   askPlaidDocs(question)              → Promise<string>
 *   searchCompanyKnowledge(query, filter) → Promise<Array<{title, snippet, url}>>
 *
 * Both wrappers read credentials from process.env and handle missing vars
 * or network failures gracefully — logging a warning and returning a safe
 * fallback so callers never have to guard against thrown errors.
 */

'use strict';

// ── AskBill (Plaid docs) ──────────────────────────────────────────────────────

/**
 * Ask AskBill a question about Plaid's products, APIs, or documentation.
 *
 * Requires env vars:
 *   ASKBILL_API_URL  — base URL for the AskBill service
 *   ASKBILL_API_KEY  — Bearer token
 *
 * @param {string} question  Natural-language question about Plaid
 * @returns {Promise<string>} Answer string, or '[AskBill unavailable]' on error
 */
async function askPlaidDocs(question) {
  const url = process.env.ASKBILL_API_URL;
  const key = process.env.ASKBILL_API_KEY;

  if (!url || !key) {
    console.warn('[mcp-clients] Warning: ASKBILL_API_URL or ASKBILL_API_KEY not set — skipping AskBill call');
    return '[AskBill unavailable]';
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      console.warn(`[mcp-clients] AskBill responded with HTTP ${res.status} — returning fallback`);
      return '[AskBill unavailable]';
    }

    const data = await res.json();

    if (typeof data.answer !== 'string') {
      console.warn('[mcp-clients] AskBill response missing .answer field — returning fallback');
      return '[AskBill unavailable]';
    }

    return data.answer;
  } catch (err) {
    console.warn(`[mcp-clients] AskBill request failed: ${err.message} — returning fallback`);
    return '[AskBill unavailable]';
  }
}

// ── Glean chat via @gleanwork/local-mcp-server ────────────────────────────────

/**
 * Chat with Glean AI using the @gleanwork/local-mcp-server MCP stdio server.
 *
 * Spawns `npx -y @gleanwork/local-mcp-server` as a child process, performs the
 * MCP JSON-RPC handshake, calls the `glean_chat` tool, and returns the response.
 *
 * Requires env vars (set in .env):
 *   GLEAN_INSTANCE   — Glean instance name (e.g. "plaid")
 *   GLEAN_API_TOKEN  — Glean API token
 *
 * @param {string} query   Natural-language question or search query
 * @returns {Promise<string>}  Glean AI response text, or '[Glean unavailable]' on error
 */
async function gleanChat(query) {
  const { spawn } = require('child_process');

  const instance = process.env.GLEAN_INSTANCE;
  const token    = process.env.GLEAN_API_TOKEN;

  if (!instance || !token) {
    console.warn('[mcp-clients] Warning: GLEAN_INSTANCE or GLEAN_API_TOKEN not set — skipping Glean call');
    return '[Glean unavailable]';
  }

  return new Promise((resolve) => {
    const child = spawn('npx', ['-y', '@gleanwork/local-mcp-server'], {
      env: { ...process.env, GLEAN_INSTANCE: instance, GLEAN_API_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let nextId = 1;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', () => {}); // suppress npx install noise

    // Send a JSON-RPC request and wait for its response by id
    const pendingRequests = new Map();

    child.stdout.on('data', () => {
      // Parse all complete newline-delimited JSON messages accumulated so far
      const lines = stdout.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const { resolve: res } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          res(msg);
        }
      }
    });

    function send(method, params, expectReply = true) {
      return new Promise((res, rej) => {
        const id = nextId++;
        const msg = { jsonrpc: '2.0', id, method, params };
        if (expectReply) pendingRequests.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify(msg) + '\n');
        if (!expectReply) res(null);
      });
    }

    function notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }

    async function run() {
      const timeout = setTimeout(() => {
        child.kill();
        resolve('[Glean unavailable: timeout]');
      }, 90000);

      try {
        // 1. Initialize
        await send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'demo-recorder', version: '1.0' },
        });

        // 2. Acknowledge initialization
        notify('notifications/initialized', {});

        // 3. Call the Glean 'chat' tool (tool name in @gleanwork/local-mcp-server v0.10+)
        const result = await send('tools/call', {
          name: 'chat',
          arguments: { message: query },
        });

        clearTimeout(timeout);
        child.stdin.end();
        child.kill();

        // Extract text from MCP tool result content blocks
        const content = result?.result?.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          resolve(text || '[Glean returned empty response]');
        } else if (typeof result?.result === 'string') {
          resolve(result.result);
        } else {
          resolve('[Glean returned unexpected format]');
        }
      } catch (err) {
        clearTimeout(timeout);
        child.kill();
        console.warn(`[mcp-clients] Glean MCP error: ${err.message}`);
        resolve('[Glean unavailable]');
      }
    }

    child.on('error', (err) => {
      console.warn(`[mcp-clients] Failed to spawn Glean MCP server: ${err.message}`);
      resolve('[Glean unavailable]');
    });

    run();
  });
}

/**
 * Backwards-compatible shim — research.js calls this for the search_company_knowledge tool.
 * Now routes through gleanChat for richer, AI-synthesized results.
 *
 * @param {string} query
 * @param {string} [filter='all']  Retained for API compatibility (not used by glean_chat)
 * @returns {Promise<string>}
 */
async function searchCompanyKnowledge(query, filter = 'all') {
  const enrichedQuery = filter && filter !== 'all'
    ? `${query} (source: ${filter})`
    : query;
  return gleanChat(enrichedQuery);
}

module.exports = { askPlaidDocs, gleanChat, searchCompanyKnowledge };
