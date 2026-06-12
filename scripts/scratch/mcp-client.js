'use strict';

/**
 * Minimal MCP stdio client (newline-delimited JSON-RPC, FastMCP-compatible).
 *
 * Extracted from scripts/scratch/scratch/mcp-video-edit.js so both the
 * scene-truth drift lane (mcp-video-edit) and the production MoviePy renderer
 * (render-moviepy) share one implementation.
 *
 * Contract notes (vidmagik / FastMCP):
 *  - messages are newline-delimited JSON-RPC 2.0 over stdio
 *  - handshake: initialize → notifications/initialized → tools/call
 *  - tool results arrive as `structuredContent` (sometimes `{result: ...}`-
 *    wrapped) or as JSON text inside `content[].text` — callTool handles both
 */

const { spawn } = require('child_process');

class McpClient {
  constructor(command, args, opts = {}) {
    this.proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = [];
    this.proc.stdout.on('data', (d) => this._onData(d));
    this.proc.stderr.on('data', (d) => {
      this.stderrTail.push(String(d));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    this.exited = new Promise((res) => this.proc.on('exit', res));
  }

  _onData(d) {
    this.buf += String(d);
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms. stderr tail: ${this.stderrTail.slice(-3).join(' ')}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params: params || {} });
  }

  async initialize() {
    const r = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'demo-recorder-mcp-client', version: '1.0.0' },
    }, 90000);
    this.notify('notifications/initialized');
    return r;
  }

  /** Call a tool and return its (parsed) result. Throws on isError results. */
  async callTool(name, args, timeoutMs = 120000) {
    const r = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
    if (r.isError) {
      const text = (r.content || []).map((c) => c.text || '').join(' ');
      throw new Error(`tool ${name} failed: ${text.slice(0, 500)}`);
    }
    if (r.structuredContent !== undefined) {
      const sc = r.structuredContent;
      return sc && typeof sc === 'object' && 'result' in sc ? sc.result : sc;
    }
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    try { this.proc.kill(); } catch (_) {}
  }
}

module.exports = { McpClient };
