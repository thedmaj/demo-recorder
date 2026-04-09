'use strict';

const fs = require('fs');
const path = require('path');
const { getRunLayout } = require('./run-io');

function resolveRunDir(explicitRunDir) {
  const runDir = String(explicitRunDir || process.env.PIPELINE_RUN_DIR || '').trim();
  return runDir || null;
}

function getLogPath(explicitRunDir) {
  const runDir = resolveRunDir(explicitRunDir);
  if (!runDir) return null;
  const layout = getRunLayout(runDir);
  fs.mkdirSync(layout.logsDir, { recursive: true });
  return path.join(layout.logsDir, 'pipeline-build.log.md');
}

function appendRaw(logPath, text) {
  if (!logPath || !text) return;
  fs.appendFileSync(logPath, text, 'utf8');
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
}

function clipText(value, maxChars = 10000) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function initPipelineBuildLog(options = {}) {
  const logPath = getLogPath(options.runDir);
  if (!logPath) return null;
  const exists = fs.existsSync(logPath);
  const now = new Date().toISOString();
  const runId = String(options.runId || path.basename(resolveRunDir(options.runDir) || '')).trim();
  const title = options.title || 'Plaid Demo Pipeline Build Log';
  if (!exists) {
    appendRaw(logPath, `# ${title}\n\n`);
    appendRaw(logPath, `- runId: \`${runId || 'unknown'}\`\n`);
    appendRaw(logPath, `- createdAt: \`${now}\`\n\n`);
  }
  appendRaw(logPath, `## [RUN] Invocation started\n\n`);
  appendRaw(logPath, `- at: \`${now}\`\n`);
  if (options.mode) appendRaw(logPath, `- mode: \`${options.mode}\`\n`);
  if (options.fromStage) appendRaw(logPath, `- fromStage: \`${options.fromStage}\`\n`);
  if (options.toStage) appendRaw(logPath, `- toStage: \`${options.toStage}\`\n`);
  if (options.runDir) appendRaw(logPath, `- runDir: \`${options.runDir}\`\n`);
  if (options.promptSnippet) appendRaw(logPath, `- promptSnippet: \`${clipText(options.promptSnippet, 240).replace(/\n/g, ' ')}\`\n`);
  appendRaw(logPath, '\n');
  return logPath;
}

function appendPipelineLogSection(title, lines = [], options = {}) {
  const logPath = getLogPath(options.runDir);
  if (!logPath) return;
  appendRaw(logPath, `## ${title}\n\n`);
  appendRaw(logPath, `- at: \`${new Date().toISOString()}\`\n`);
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (line == null) continue;
      appendRaw(logPath, `- ${String(line).replace(/\n/g, ' ')}\n`);
    }
  }
  appendRaw(logPath, '\n');
}

function appendPipelineLogJson(title, payload, options = {}) {
  const logPath = getLogPath(options.runDir);
  if (!logPath) return;
  appendRaw(logPath, `## ${title}\n\n`);
  appendRaw(logPath, `- at: \`${new Date().toISOString()}\`\n\n`);
  appendRaw(logPath, '```json\n');
  appendRaw(logPath, `${safeJson(payload)}\n`);
  appendRaw(logPath, '```\n\n');
}

function appendResearchToolExchange(payload = {}, options = {}) {
  const logPath = getLogPath(options.runDir);
  if (!logPath) return;
  const iteration = payload.iteration || '?';
  const toolName = payload.toolName || 'unknown_tool';
  appendRaw(logPath, `### [Research] Iteration ${iteration} — ${toolName}\n\n`);
  appendRaw(logPath, `- at: \`${new Date().toISOString()}\`\n`);
  if (payload.query) appendRaw(logPath, `- query: \`${clipText(payload.query, 1000).replace(/\n/g, ' ')}\`\n`);
  if (payload.error) appendRaw(logPath, `- status: \`error\`\n- error: \`${clipText(payload.error, 1200).replace(/\n/g, ' ')}\`\n\n`);
  else appendRaw(logPath, '- status: `ok`\n\n');
  if (payload.response != null) {
    appendRaw(logPath, '```text\n');
    appendRaw(logPath, `${clipText(payload.response, Number(payload.maxChars) > 0 ? Number(payload.maxChars) : 6000)}\n`);
    appendRaw(logPath, '```\n\n');
  }
}

module.exports = {
  getLogPath,
  initPipelineBuildLog,
  appendPipelineLogSection,
  appendPipelineLogJson,
  appendResearchToolExchange,
};
