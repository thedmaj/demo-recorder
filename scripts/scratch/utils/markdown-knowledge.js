'use strict';

/**
 * Shared markdown + frontmatter helpers for product knowledge (dashboard + tests).
 */

const DEFAULT_STALE_DAYS = parseInt(process.env.KNOWLEDGE_STALE_DAYS || '90', 10);

/**
 * Parse YAML frontmatter (simple key: value lines). Tolerates CRLF after ---.
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') return {};
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const obj = {};
  m[1].split(/\r?\n/).forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;
    const k = line.slice(0, colonIdx).trim();
    if (!k) return;
    let v = line.slice(colonIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    obj[k] = v;
  });
  return obj;
}

function parseFlexibleDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return t;
}

function daysSince(ts) {
  if (ts == null) return null;
  return Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
}

/**
 * @param {Record<string, string>} fm
 * @param {{ staleDaysThreshold?: number }} [opts]
 */
function computeStaleness(fm, opts = {}) {
  const threshold = opts.staleDaysThreshold != null ? opts.staleDaysThreshold : DEFAULT_STALE_DAYS;
  const reviewed = parseFlexibleDate(fm.last_human_review);
  const staleDays = reviewed != null ? daysSince(reviewed) : null;
  const staleByAge = staleDays != null && staleDays > threshold;
  return { staleDays, staleByAge, staleThresholdDays: threshold };
}

const DRAFT_RE = /\[(DRAFT|draft)\]|\*\*DRAFT\*\*/i;

function isDraftText(text) {
  return DRAFT_RE.test(text || '');
}

/**
 * Strip draft markers from a single line (approve).
 * @param {string} line
 */
function stripDraftMarkers(line) {
  return line
    .replace(/\[(DRAFT|draft)\]\s*/gi, '')
    .replace(/\*\*DRAFT\*\*\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trimEnd();
}

/**
 * Extract atomic "facts" for HITL review (bullets, blockquotes, table rows).
 * @param {string} content full markdown including frontmatter
 * @returns {{ facts: object[], bodyStartLine: number }}
 */
function extractFactsFromMarkdown(content) {
  if (!content) return { facts: [], bodyStartLine: 1 };

  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const bodyStartLine = fmMatch ? fmMatch[0].split(/\r?\n/).length + 1 : 1;

  const lines = body.split(/\r?\n/);
  let currentSection = 'Preamble';
  const facts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = bodyStartLine + i;
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      currentSection = h2[1].trim();
      continue;
    }
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      currentSection = h3[1].trim();
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;

    if (/^\|/.test(trimmed) && trimmed.includes('|')) {
      if (/^[\s|:-]+$/.test(trimmed)) continue;
      const isHeaderRow = /metric|value|source/i.test(trimmed) && /^\|/.test(trimmed);
      if (isHeaderRow) continue;
      facts.push({
        id: `L${lineNo}`,
        section: currentSection,
        type: 'table-row',
        text: trimmed,
        draft: isDraftText(trimmed),
        lineStart: lineNo,
        lineEnd: lineNo,
      });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      facts.push({
        id: `L${lineNo}`,
        section: currentSection,
        type: 'blockquote',
        text: trimmed.replace(/^>\s?/, ''),
        draft: isDraftText(trimmed),
        lineStart: lineNo,
        lineEnd: lineNo,
      });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      facts.push({
        id: `L${lineNo}`,
        section: currentSection,
        type: 'bullet',
        text: trimmed.replace(/^[-*]\s+/, ''),
        draft: isDraftText(trimmed),
        lineStart: lineNo,
        lineEnd: lineNo,
      });
    }
  }

  return { facts, bodyStartLine };
}

function countDraftFacts(facts) {
  return (facts || []).filter(f => f.draft).length;
}

/**
 * Apply approve / reject / edit to lines by 1-based line number (full file).
 * @param {string} fullContent
 * @param {{ op: string, lineStart: number, text?: string }} action
 */
function applyFactOperation(fullContent, action) {
  const lines = fullContent.split(/\r?\n/);
  const idx = (action.lineStart || 0) - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new Error(`Invalid lineStart ${action.lineStart}`);
  }
  const op = (action.op || '').toLowerCase();
  if (op === 'approve') {
    lines[idx] = stripDraftMarkers(lines[idx]);
    return lines.join('\n');
  }
  if (op === 'reject') {
    lines.splice(idx, 1);
    return lines.join('\n');
  }
  if (op === 'edit') {
    if (typeof action.text !== 'string') throw new Error('edit requires text');
    const line = lines[idx];
    const preserved = /^\s+/.exec(line);
    const indent = preserved ? preserved[0] : '';
    if (/^[-*]\s+/.test(line.trim())) {
      const rest = action.text.replace(/^\s*[-*]\s+/, '');
      lines[idx] = `${indent}- ${rest}`;
    } else if (/^>\s?/.test(line.trim())) {
      lines[idx] = `${indent}> ${action.text.replace(/^>\s?/, '')}`;
    } else {
      lines[idx] = indent + action.text.trim();
    }
    return lines.join('\n');
  }
  throw new Error(`Unknown op: ${action.op}`);
}

/**
 * Resolve fact id like "L42" to line number.
 * @param {string} factId
 */
function parseFactLine(factId) {
  const m = /^L(\d+)$/.exec(factId || '');
  if (!m) return null;
  return parseInt(m[1], 10);
}

module.exports = {
  parseFrontmatter,
  parseFlexibleDate,
  computeStaleness,
  extractFactsFromMarkdown,
  countDraftFacts,
  applyFactOperation,
  parseFactLine,
  stripDraftMarkers,
  isDraftText,
  DEFAULT_STALE_DAYS,
};
