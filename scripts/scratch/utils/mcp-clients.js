/**
 * mcp-clients.js
 *
 * Knowledge-source wrappers used by the Plaid demo pipeline.
 * Includes:
 * - AskBill (MCP stdio / MCP websocket bridge / legacy HTTP fallback)
 * - Glean chat (MCP stdio)
 * - Solutions Master (HTTP or MCP stdio, selectable by env)
 */

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function safeJsonParse(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

function tryExtractJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsed = safeJsonParse(fenced.trim());
    if (parsed) return parsed;
  }
  const obj = text.match(/(\{[\s\S]*\})/)?.[1];
  if (obj) {
    const parsed = safeJsonParse(obj.trim());
    if (parsed) return parsed;
  }
  return null;
}

function normalizeToArray(value, fallbackKeys = []) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of fallbackKeys) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Generic MCP stdio tool caller.
 * @param {string} command shell command to start MCP server
 * @param {string} toolName MCP tool name
 * @param {object} args tool arguments
 * @param {object} [envExtra] extra env vars
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function callMcpToolViaStdio(command, toolName, args = {}, envExtra = {}, timeoutMs = 90000) {
  if (!command || !String(command).trim()) {
    throw new Error('MCP command not configured');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      env: { ...process.env, ...(envExtra || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let nextId = 1;
    const pendingRequests = new Map();

    const cleanup = () => {
      try { child.stdin.end(); } catch (_) {}
      try { child.kill(); } catch (_) {}
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP timeout while calling tool "${toolName}"`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id != null && pendingRequests.has(msg.id)) {
          const { resolve: res } = pendingRequests.get(msg.id);
          pendingRequests.delete(msg.id);
          res(msg);
        }
      }
    });
    child.stderr.on('data', () => {}); // keep stderr quiet; callers handle tool errors
    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    const send = (method, params, expectReply = true) => {
      return new Promise((res, rej) => {
        const id = nextId++;
        if (expectReply) pendingRequests.set(id, { resolve: res, reject: rej });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        if (!expectReply) res(null);
      });
    };
    const notify = (method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };

    (async () => {
      try {
        await send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'demo-recorder', version: '1.0' },
        });
        notify('notifications/initialized', {});
        const result = await send('tools/call', { name: toolName, arguments: args });
        clearTimeout(timer);
        cleanup();
        resolve(result?.result ?? result);
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    })();
  });
}

function extractMcpText(resultObj) {
  const content = resultObj?.content;
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  if (typeof resultObj?.text === 'string') return resultObj.text;
  if (typeof resultObj === 'string') return resultObj;
  return '';
}

// ── AskBill (Plaid docs) ──────────────────────────────────────────────────────

function normalizeAskBillText(raw) {
  if (!raw) return '';
  let text = String(raw);
  text = text.replace(/\r\n/g, '\n');

  // Keep only final "content" sections when MCP emits progressive updates.
  const contentChunks = [];
  const re = /GLEAN_AI\s*\(CONTENT\):\s*([\s\S]*?)(?=\nGLEAN_AI\s*\(|$)/gi;
  let m;
  while ((m = re.exec(text))) {
    const chunk = (m[1] || '').trim();
    if (chunk) contentChunks.push(chunk);
  }
  if (contentChunks.length > 0) {
    text = contentChunks[contentChunks.length - 1];
  }

  // Remove visible progress/update chatter if present in plain text streams.
  text = text
    .split('\n')
    .filter((line) => !/^\s*GLEAN_AI\s*\(UPDATE\):/i.test(line))
    .join('\n')
    .trim();

  return text;
}

function buildAskBillMcpCommand() {
  // Primary: explicit command (stdio launcher or websocket bridge launcher).
  const explicit = firstNonEmpty(process.env.ASKBILL_MCP_COMMAND);
  if (explicit) return explicit;

  // Secondary: mirror Cursor MCP config in this repo (.mcp.json).
  try {
    const root = path.resolve(__dirname, '../../..');
    const mcpPath = path.join(root, '.mcp.json');
    if (fs.existsSync(mcpPath)) {
      const parsed = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const server =
        parsed?.mcpServers?.['askbill-plaid'] ||
        parsed?.mcpServers?.askbill ||
        parsed?.mcpServers?.askbillPlaid;
      if (server && String(server.type || '').toLowerCase() === 'stdio' && server.command) {
        const args = Array.isArray(server.args) ? server.args : [];
        const cmd = [server.command, ...args].map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(' ');
        if (cmd.trim()) return cmd;
      }
    }
  } catch (_) {
    // Best effort only.
  }

  // Optional convenience: websocket URL -> generic MCP remote bridge.
  // Example: ASKBILL_API_URL=wss://askbill.example.com/mcp
  const maybeWsUrl = firstNonEmpty(process.env.ASKBILL_API_URL, process.env.ASKBILL_MCP_URL);
  if (/^wss?:\/\//i.test(maybeWsUrl)) {
    return `npx -y mcp-remote "${maybeWsUrl}"`;
  }
  return '';
}

/**
 * Ask AskBill a question about Plaid's products, APIs, or documentation.
 *
 * Preferred env vars:
 *   ASKBILL_MCP_COMMAND — command to launch AskBill MCP server/bridge (no API key required)
 * Optional:
 *   ASKBILL_API_URL     — if ws:// or wss://, auto-bridged via `npx -y mcp-remote "<url>"`
 *
 * Legacy fallback (kept for compatibility):
 *   ASKBILL_API_URL     — HTTP endpoint
 *
 * @param {string} question  Natural-language question about Plaid
 * @returns {Promise<string>} Answer string, or '[AskBill unavailable]' on error
 */
async function askPlaidDocs(question) {
  const mcpCommand = buildAskBillMcpCommand();
  const url = firstNonEmpty(process.env.ASKBILL_API_URL);

  // Preferred path: AskBill MCP server (matches Cursor MCP usage model).
  if (mcpCommand) {
    const candidates = [
      { name: 'plaid_docs', arguments: { question } },
      { name: 'ask_bill', arguments: { question } },
      { name: 'ask_plaid_docs', arguments: { question } },
      { name: 'ask_docs', arguments: { question } },
      { name: 'chat', arguments: { message: question } },
      { name: 'query', arguments: { query: question } },
    ];
    for (const c of candidates) {
      try {
        const result = await callMcpToolViaStdio(mcpCommand, c.name, c.arguments, {}, 90000);
        const text = normalizeAskBillText(extractMcpText(result));
        if (text && !/^\s*unknown tool:/i.test(text)) return text;
      } catch (_) {
        // Try next likely tool shape.
      }
    }
    console.warn('[mcp-clients] AskBill MCP call failed across known tool signatures — falling back');
  }

  // Legacy HTTP fallback (no API key required).
  if (!url || /^wss?:\/\//i.test(url)) {
    console.warn('[mcp-clients] Warning: AskBill MCP not configured and no usable HTTP URL set — skipping AskBill call');
    return '[AskBill unavailable]';
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

function buildGleanTopRelevantPrompt(query) {
  const q = String(query || '').trim();
  return (
    `${q}\n\n` +
    'Return only the final synthesized answer with the top 5 most relevant findings for this request.\n' +
    '- Use concise bullets only (max 5 bullets, <= 28 words each).\n' +
    '- Prioritize directly actionable details for demo-building.\n' +
    '- Include source context in-line only when highly relevant.\n' +
    '- Do not include search process updates, reasoning steps, or tool chatter.'
  );
}

function normalizeGleanText(raw) {
  let text = normalizeAskBillText(raw);
  if (!text) return '';

  // Keep response compact for downstream token budget.
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((line) => !/^[-*]\s*$/.test(line));

  const bullets = lines.filter((l) => /^[-*]\s+/.test(l));
  if (bullets.length > 0) {
    return bullets.slice(0, 5).join('\n').slice(0, 1800);
  }

  // Fallback to a bounded plain-text excerpt.
  return lines.slice(0, 8).join('\n').slice(0, 1800);
}

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
  const instance = process.env.GLEAN_INSTANCE;
  const token    = process.env.GLEAN_API_TOKEN;

  if (!instance || !token) {
    console.warn('[mcp-clients] Warning: GLEAN_INSTANCE or GLEAN_API_TOKEN not set — skipping Glean call');
    return '[Glean unavailable]';
  }

  try {
    const result = await callMcpToolViaStdio(
      'npx -y @gleanwork/local-mcp-server',
      'chat',
      { message: buildGleanTopRelevantPrompt(query) },
      { GLEAN_INSTANCE: instance, GLEAN_API_TOKEN: token },
      90000
    );
    const text = normalizeGleanText(extractMcpText(result));
    return text || '[Glean returned empty response]';
  } catch (err) {
    console.warn(`[mcp-clients] Glean MCP error: ${err.message}`);
    return '[Glean unavailable]';
  }
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

// ── Solutions Master (HTTP + MCP stdio) ──────────────────────────────────────

function extractSolutionNamesFromPrompt(promptText = '') {
  const text = String(promptText || '');
  const names = [];
  const lineMatch = text.match(/^\s*(?:Solutions?|Supported\s+Solutions?)\s*:\s*(.+)$/im);
  if (lineMatch && lineMatch[1]) {
    lineMatch[1]
      .split(/[|,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((s) => names.push(s));
  }

  const lines = text.split('\n');
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-=]{3,}$/.test(line)) continue;
    if (/^solutions?\s*(supported)?$/i.test(line.replace(/[:#*`]/g, '').trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!line) break;
    if (/^[A-Z][A-Z\s/&-]{3,}$/.test(line)) break; // next heading
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && bullet[1]) {
      names.push(bullet[1].trim());
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      names.push(line.replace(/^\d+\.\s+/, '').trim());
      continue;
    }
    if (line.includes(',')) {
      line.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => names.push(s));
      continue;
    }
    names.push(line);
  }
  return uniqStrings(names.map((s) => s.replace(/^["'`]|["'`]$/g, '')));
}

function normalizeSolutionsMasterToolResult(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return tryExtractJsonBlock(raw) || safeJsonParse(raw) || raw;
  const text = extractMcpText(raw);
  if (text) {
    const parsedText = tryExtractJsonBlock(text) || safeJsonParse(text);
    if (parsedText) return parsedText;
    return text;
  }
  if (raw?.structuredContent && typeof raw.structuredContent === 'object') return raw.structuredContent;
  return raw;
}

async function callSolutionsMasterToolViaHttp(baseUrl, apiKey, toolName, args = {}) {
  const url = String(baseUrl || '').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const attempts = [
    { endpoint: `${url}/tools/call`, body: { name: toolName, arguments: args } },
    { endpoint: `${url}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const res = await fetch(a.endpoint, { method: 'POST', headers, body: JSON.stringify(a.body) });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} from ${a.endpoint}`);
        continue;
      }
      const data = await res.json();
      return normalizeSolutionsMasterToolResult(data?.result ?? data);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Solutions Master HTTP call failed');
}

async function callSolutionsMasterToolViaMcpStdio(command, toolName, args = {}, envExtra = {}) {
  const result = await callMcpToolViaStdio(command, toolName, args, envExtra, 120000);
  return normalizeSolutionsMasterToolResult(result);
}

async function callSolutionsMasterTool(toolName, args = {}) {
  const transport = (process.env.SOLUTIONS_MASTER_TRANSPORT || 'auto').toLowerCase().trim();
  const apiUrl = process.env.SOLUTIONS_MASTER_API_URL || '';
  const apiKey = process.env.SOLUTIONS_MASTER_API_KEY || '';
  const mcpCommand = process.env.SOLUTIONS_MASTER_MCP_COMMAND || '';

  const warnings = [];
  const tryHttp = transport === 'http' || transport === 'auto';
  const tryMcp = transport === 'mcp' || transport === 'auto';

  if (tryHttp && apiUrl) {
    try {
      return { data: await callSolutionsMasterToolViaHttp(apiUrl, apiKey, toolName, args), transportUsed: 'http', warnings };
    } catch (err) {
      warnings.push(`HTTP ${toolName} failed: ${err.message}`);
      if (transport === 'http') throw new Error(warnings[warnings.length - 1]);
    }
  }
  if (tryMcp && mcpCommand) {
    try {
      const env = {};
      if (apiKey) env.SOLUTIONS_MASTER_API_KEY = apiKey;
      if (apiUrl) env.SOLUTIONS_MASTER_API_URL = apiUrl;
      return {
        data: await callSolutionsMasterToolViaMcpStdio(mcpCommand, toolName, args, env),
        transportUsed: 'mcp',
        warnings,
      };
    } catch (err) {
      warnings.push(`MCP ${toolName} failed: ${err.message}`);
      if (transport === 'mcp') throw new Error(warnings[warnings.length - 1]);
    }
  }
  throw new Error(
    warnings.join(' | ') ||
      'Solutions Master not configured. Set SOLUTIONS_MASTER_API_URL (+ SOLUTIONS_MASTER_API_KEY) or SOLUTIONS_MASTER_MCP_COMMAND.'
  );
}

function scoreSolutionMatch(sol, requestedName) {
  const req = String(requestedName || '').toLowerCase().trim();
  if (!req) return 0;
  const name = String(sol?.name || '').toLowerCase();
  const aliases = normalizeToArray(sol?.aliases).map((a) => String(a).toLowerCase());
  if (name === req || aliases.includes(req)) return 100;
  if (name.includes(req) || req.includes(name)) return 80;
  for (const a of aliases) {
    if (a.includes(req) || req.includes(a)) return 70;
  }
  return 0;
}

function extractApiNamesFromComponent(component) {
  const candidates = [];
  const fields = ['api', 'apis', 'apiVersion', 'apiName', 'endpoints', 'endpoint', 'integrations', 'services'];
  for (const key of fields) {
    const v = component?.[key];
    if (typeof v === 'string') candidates.push(v);
    else if (Array.isArray(v)) candidates.push(...v.map((x) => (typeof x === 'string' ? x : firstNonEmpty(x?.name, x?.api, x?.endpoint))));
  }
  return uniqStrings(candidates);
}

function collectValuePropositions(obj) {
  const list = [];
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      const s = value.trim();
      if (!s) return;
      if (/value proposition|outcome|benefit|why it matters|business value/i.test(s)) list.push(s);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => visit(v, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (/(value.?prop|benefit|outcome|messaging|statement|description)/i.test(k) && typeof v === 'string') {
          list.push(v.trim());
        } else {
          visit(v, depth + 1);
        }
      }
    }
  };
  visit(obj, 0);
  return uniqStrings(list).slice(0, 50);
}

async function resolveSolutionsMasterContext(promptText = '') {
  const requestedSolutionNames = extractSolutionNamesFromPrompt(promptText);
  if (requestedSolutionNames.length === 0) {
    return {
      requestedSolutionNames: [],
      resolvedSolutions: [],
      unresolvedSolutionNames: [],
      valuePropositionStatements: [],
      apiNames: [],
      transportUsed: null,
      warnings: ['No solution names specified in prompt (Solutions: ...).'],
    };
  }

  let transportUsed = null;
  const warnings = [];

  const listCall = await callSolutionsMasterTool('solution_list', { status: 'active', limit: 250 });
  transportUsed = listCall.transportUsed;
  warnings.push(...(listCall.warnings || []));
  const allSolutions = normalizeToArray(listCall.data, ['solutions', 'items', 'data']);

  const matched = [];
  const unresolvedSolutionNames = [];
  for (const reqName of requestedSolutionNames) {
    let winner = null;
    let winnerScore = 0;
    for (const s of allSolutions) {
      const score = scoreSolutionMatch(s, reqName);
      if (score > winnerScore) {
        winner = s;
        winnerScore = score;
      }
    }
    if (!winner || winnerScore < 70) {
      unresolvedSolutionNames.push(reqName);
      continue;
    }
    matched.push(winner);
  }

  const resolvedSolutions = [];
  const mergedValueProps = [];
  const apiNames = [];

  for (const base of matched) {
    const id = firstNonEmpty(base.id, base.solutionId, base.uuid, base.identifier);
    const name = firstNonEmpty(base.name, base.title);
    if (!id || !name) continue;

    const summary = {
      id,
      name,
      description: firstNonEmpty(base.description, base.summary),
      category: firstNonEmpty(base.category),
      status: firstNonEmpty(base.status),
      version: firstNonEmpty(base.version),
      keyChallenges: normalizeToArray(base.keyChallenges),
      aliases: normalizeToArray(base.aliases),
      components: [],
      playbooks: [],
      valuePropositionStatements: [],
      apis: [],
    };

    try {
      const readCall = await callSolutionsMasterTool('solution_read', { id, includeComponents: true, includeStrategies: true });
      warnings.push(...(readCall.warnings || []));
      transportUsed = transportUsed || readCall.transportUsed;
      const details = readCall.data && typeof readCall.data === 'object' ? readCall.data : {};
      summary.description = firstNonEmpty(summary.description, details.description, details.summary);
      summary.category = firstNonEmpty(summary.category, details.category);
      summary.status = firstNonEmpty(summary.status, details.status);
      summary.version = firstNonEmpty(summary.version, details.version);
      summary.keyChallenges = uniqStrings([...summary.keyChallenges, ...normalizeToArray(details.keyChallenges)]);
      summary.aliases = uniqStrings([...summary.aliases, ...normalizeToArray(details.aliases)]);

      const componentRows = normalizeToArray(details.components, ['components', 'items', 'data']);
      for (const c of componentRows) {
        const item = {
          id: firstNonEmpty(c.id, c.componentId, c.uuid, c.identifier),
          name: firstNonEmpty(c.name, c.title),
          description: firstNonEmpty(c.description, c.summary),
          status: firstNonEmpty(c.status),
          apiVersion: firstNonEmpty(c.apiVersion),
          apis: extractApiNamesFromComponent(c),
        };
        summary.components.push(item);
        apiNames.push(...item.apis);
      }
    } catch (err) {
      warnings.push(`solution_read failed for "${name}": ${err.message}`);
    }

    try {
      const componentsCall = await callSolutionsMasterTool('component_list', {
        solutionId: id,
        includeRelationships: false,
        limit: 250,
      });
      warnings.push(...(componentsCall.warnings || []));
      const rows = normalizeToArray(componentsCall.data, ['components', 'items', 'data']);
      for (const c of rows) {
        const cid = firstNonEmpty(c.id, c.componentId, c.uuid, c.identifier);
        if (cid && summary.components.some((x) => x.id === cid)) continue;
        const item = {
          id: cid,
          name: firstNonEmpty(c.name, c.title),
          description: firstNonEmpty(c.description, c.summary),
          status: firstNonEmpty(c.status),
          apiVersion: firstNonEmpty(c.apiVersion),
          apis: extractApiNamesFromComponent(c),
        };
        summary.components.push(item);
        apiNames.push(...item.apis);
      }
    } catch (err) {
      warnings.push(`component_list failed for "${name}": ${err.message}`);
    }

    try {
      const pbCall = await callSolutionsMasterTool('discover_playbooks', {
        solution: name,
        showGaps: false,
      });
      warnings.push(...(pbCall.warnings || []));
      const playbooks = normalizeToArray(pbCall.data, ['playbooks', 'items', 'data']);
      for (const pb of playbooks) {
        summary.playbooks.push({
          id: firstNonEmpty(pb.id, pb.playbookId, pb.uuid, pb.identifier),
          name: firstNonEmpty(pb.name, pb.title),
          description: firstNonEmpty(pb.description, pb.summary),
          status: firstNonEmpty(pb.status),
          segment: firstNonEmpty(pb.segment, pb.segmentName),
        });
      }
    } catch (err) {
      warnings.push(`discover_playbooks failed for "${name}": ${err.message}`);
    }

    try {
      const vpCall = await callSolutionsMasterTool('find_sales_content', {
        solution: name,
        playType: 'VALUE_PROPOSITION',
        includeRelationships: true,
        limit: 50,
      });
      warnings.push(...(vpCall.warnings || []));
      const vps = collectValuePropositions(vpCall.data);
      summary.valuePropositionStatements = uniqStrings([...summary.valuePropositionStatements, ...vps]);
    } catch (err) {
      warnings.push(`find_sales_content failed for "${name}": ${err.message}`);
    }

    summary.apis = uniqStrings(summary.components.flatMap((c) => c.apis || []));
    apiNames.push(...summary.apis);
    mergedValueProps.push(...summary.valuePropositionStatements);
    resolvedSolutions.push(summary);
  }

  return {
    requestedSolutionNames,
    resolvedSolutions,
    unresolvedSolutionNames,
    valuePropositionStatements: uniqStrings(mergedValueProps),
    apiNames: uniqStrings(apiNames),
    transportUsed,
    warnings: uniqStrings(warnings),
  };
}

module.exports = {
  askPlaidDocs,
  gleanChat,
  searchCompanyKnowledge,
  extractSolutionNamesFromPrompt,
  resolveSolutionsMasterContext,
};
