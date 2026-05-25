'use strict';

/**
 * Skills sync parity test.
 *
 * Enforces the convention documented in AGENTS.md → "Skills sync convention":
 *   - Every skill should be discoverable in both Claude Code (.claude/skills/)
 *     and Cursor (.cursor/skills/) agent modes — unless explicitly allowlisted.
 *   - Skills under the symlink pattern resolve to a real .agents/skills/<name>/
 *     directory containing a non-empty SKILL.md.
 *
 * When adding a new skill, update both locations in the same commit. If a
 * skill is intentionally agent-specific, add it to the allowlist below WITH
 * a comment explaining why.
 */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../..');
const CLAUDE_SKILLS_DIR = path.join(ROOT, '.claude/skills');
const CURSOR_SKILLS_DIR = path.join(ROOT, '.cursor/skills');
const AGENTS_SKILLS_DIR = path.join(ROOT, '.agents/skills');

// Skills intentionally present in Claude but not Cursor. Each entry needs a reason.
const CLAUDE_ONLY_ALLOWLIST = new Set([
  // Internal Claude Code workflow skills (no Cursor analog needed).
  'advanced-prompting-techniques',
  'audio-sync-mastery',
  'pipeline-cli',
  'plaid-integration-bundle',
  'remotion-studio',
  'saas-demo-design-principles',
  // Symlink-to-.agents, mirrored to Cursor not yet (legacy pattern).
  // To bring Cursor in, add a sibling symlink under .cursor/skills/.
  'remotion-best-practices',
]);

// Skills intentionally present in Cursor but not Claude.
const CURSOR_ONLY_ALLOWLIST = new Set([
  // Legacy Cursor skill that predates the parity convention. Tracked for removal
  // or migration; do not add new Cursor-only skills without updating AGENTS.md.
  'plaid-integration',
]);

// Skills that must be canonical at .agents/ and accessible via both Claude AND
// Cursor symlinks (full parity for asset-heavy skills).
const FULL_PARITY_SYMLINK_SKILLS = ['tosea-slide-workhorse'];

function listSkills(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name);
}

function skillHasSkillMd(dir, name) {
  return fs.existsSync(path.join(dir, name, 'SKILL.md'));
}

test('every Claude skill has a Cursor counterpart (or is allowlisted)', () => {
  const claudeSkills = listSkills(CLAUDE_SKILLS_DIR);
  const missing = [];
  for (const name of claudeSkills) {
    if (CLAUDE_ONLY_ALLOWLIST.has(name)) continue;
    if (!skillHasSkillMd(CURSOR_SKILLS_DIR, name)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `Skills present in .claude/skills/ but missing from .cursor/skills/:\n  - ${missing.join('\n  - ')}\n` +
      `Either add the Cursor counterpart or add the name to CLAUDE_ONLY_ALLOWLIST in this test with a reason.`
  );
});

test('every Cursor skill has a Claude counterpart (or is allowlisted)', () => {
  const cursorSkills = listSkills(CURSOR_SKILLS_DIR);
  const missing = [];
  for (const name of cursorSkills) {
    if (CURSOR_ONLY_ALLOWLIST.has(name)) continue;
    if (!skillHasSkillMd(CLAUDE_SKILLS_DIR, name)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `Skills present in .cursor/skills/ but missing from .claude/skills/:\n  - ${missing.join('\n  - ')}\n` +
      `Either add the Claude counterpart or add the name to CURSOR_ONLY_ALLOWLIST in this test with a reason.`
  );
});

test('every .agents/skills/<name>/SKILL.md is a real non-empty file', () => {
  if (!fs.existsSync(AGENTS_SKILLS_DIR)) {
    // No .agents/ inventory — acceptable for some repos but ours uses it.
    return;
  }
  for (const name of listSkills(AGENTS_SKILLS_DIR)) {
    const skillPath = path.join(AGENTS_SKILLS_DIR, name, 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), `Missing ${skillPath}`);
    const stat = fs.lstatSync(skillPath);
    assert.equal(stat.isSymbolicLink(), false, `${skillPath} must be a real file, not a symlink`);
    const size = stat.size;
    assert.ok(size > 0, `${skillPath} is empty (${size} bytes)`);
  }
});

test('full-parity symlink skills resolve to the same .agents canonical', () => {
  for (const name of FULL_PARITY_SYMLINK_SKILLS) {
    const agentsPath = path.join(AGENTS_SKILLS_DIR, name);
    const claudePath = path.join(CLAUDE_SKILLS_DIR, name);
    const cursorPath = path.join(CURSOR_SKILLS_DIR, name);

    assert.ok(fs.existsSync(agentsPath), `Canonical missing: ${agentsPath}`);
    assert.ok(fs.existsSync(claudePath), `Claude symlink missing: ${claudePath}`);
    assert.ok(fs.existsSync(cursorPath), `Cursor symlink missing: ${cursorPath}`);

    const agentsReal = fs.realpathSync(agentsPath);
    const claudeReal = fs.realpathSync(claudePath);
    const cursorReal = fs.realpathSync(cursorPath);

    assert.equal(
      claudeReal,
      agentsReal,
      `${claudePath} must resolve to ${agentsPath} (got ${claudeReal})`
    );
    assert.equal(
      cursorReal,
      agentsReal,
      `${cursorPath} must resolve to ${agentsPath} (got ${cursorReal})`
    );
  }
});

test('AGENTS.md documents the skills sync convention', () => {
  const md = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(md, /Skills sync convention/i, 'AGENTS.md must include the Skills sync convention section');
  assert.match(md, /\.claude\/skills/, 'AGENTS.md must reference .claude/skills');
  assert.match(md, /\.cursor\/skills/, 'AGENTS.md must reference .cursor/skills');
  assert.match(md, /skills-parity\.test\.js/, 'AGENTS.md must reference this parity test');
});
