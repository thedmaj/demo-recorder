'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadSlideDesignSkill,
  getSlideDesignBriefPaths,
  SLIDE_HOST_ISOLATION_BLOCK,
} = require('../../scripts/scratch/utils/slide-design-skill');
const { buildSlideInsertionPrompt } = require('../../scripts/scratch/utils/prompt-templates');

const ROOT = path.join(__dirname, '../..');

test('loadSlideDesignSkill loads plaid-slide-design SKILL.md', () => {
  const out = loadSlideDesignSkill({ projectRoot: ROOT });
  assert.equal(out.skillLoaded, true);
  assert.ok(out.text.includes('SLIDE vs HOST APP'));
  assert.ok(out.text.includes('DECK_DESIGN_SYSTEM.md'));
  assert.ok(fs.existsSync(out.markdownPath));
});

test('loadSlideDesignSkill merges plaid-workhorse-slides hybrid skill', () => {
  const out = loadSlideDesignSkill({ projectRoot: ROOT });
  assert.equal(out.workhorseHybridLoaded, true);
  assert.ok(out.text.includes('Plaid × Workhorse'));
  assert.ok(out.text.includes('data-workhorse-layout'));
  assert.ok(fs.existsSync(path.join(ROOT, '.claude/skills/plaid-workhorse-slides/SKILL.md')));
});

test('tosea-slide-workhorse installed for Claude Agent mode', () => {
  const claudeSkill = path.join(ROOT, '.claude/skills/tosea-slide-workhorse/SKILL.md');
  const layouts = path.join(ROOT, '.claude/skills/tosea-slide-workhorse/templates/single-page/kpi-grid.html');
  assert.ok(fs.existsSync(claudeSkill), 'Claude workhorse SKILL.md must exist');
  assert.ok(fs.existsSync(layouts), 'Claude workhorse layout assets must exist');
});

test('getSlideDesignBriefPaths points at brand-design-briefs', () => {
  const paths = getSlideDesignBriefPaths(ROOT);
  assert.ok(fs.existsSync(paths.deckDesignSystem));
  assert.ok(fs.existsSync(paths.deckTemplates));
  assert.ok(fs.existsSync(paths.deckComposition));
});

test('buildSlideInsertionPrompt injects showcase template skeleton, not T3 shell', () => {
  const { getShowcaseTemplateSkeletonForRouting } = require('../../scripts/scratch/utils/showcase-template-extract');
  const { routeSlideTemplate } = require('../../scripts/scratch/utils/slide-template-router');
  const routing = routeSlideTemplate(
    { id: 'insight-kpi', narration: 'Three KPI tiles show 94% acceptance rate.' },
    { stepIndex: 1, totalSlides: 3 }
  );
  const showcaseTemplate = getShowcaseTemplateSkeletonForRouting(routing, { projectRoot: ROOT });
  const { userMessages } = buildSlideInsertionPrompt({
    step: { id: 'insight-kpi', label: 'KPI', sceneType: 'slide', stepKind: 'slide' },
    brand: { name: 'Huntington Bank' },
    slideDesignSkillMarkdown: 'SKILL EXCERPT',
    deckDesignSystem: '# Plaid Deck Design System\n--plaid-teal-500',
    templateRouting: routing,
    showcaseTemplate,
  });
  const user = userMessages[0].content;
  assert.match(user, /RECOMMENDED SHOWCASE TEMPLATE/);
  assert.match(user, /workhorse-layout/);
  assert.doesNotMatch(user, /REFERENCE SHELL \(T3 statement/);
  assert.doesNotMatch(user, /pipeline-slide-shell\.html/);
});

test('buildSlideInsertionPrompt always injects host isolation + skill', () => {
  const { userMessages } = buildSlideInsertionPrompt({
    step: { id: 'auth-insight', label: 'Auth', sceneType: 'insight', stepKind: 'slide' },
    brand: { name: 'Huntington Bank' },
    slideDesignSkillMarkdown: 'SKILL EXCERPT',
    deckDesignSystem: '# Plaid Deck Design System\n--plaid-teal-500',
  });
  const user = userMessages[0].content;
  assert.match(user, /Customer context \(copy only/);
  assert.match(user, /SLIDE vs HOST/);
  assert.match(user, /SKILL EXCERPT/);
  assert.match(user, /DESIGN SYSTEM \(tokens \+ shell\)/);
  assert.doesNotMatch(user, /^Brand: Huntington/m);
});

test('SLIDE_HOST_ISOLATION_BLOCK forbids customer palette in slides', () => {
  assert.match(SLIDE_HOST_ISOLATION_BLOCK, /never customer\/host brand colors/);
});

test('skill is discoverable in both Claude and Cursor agent modes', () => {
  const claudePath = path.join(ROOT, '.claude/skills/plaid-slide-design/SKILL.md');
  const cursorPath = path.join(ROOT, '.cursor/skills/plaid-slide-design/SKILL.md');
  const cursorRule = path.join(ROOT, '.cursor/rules/plaid-slide-design.mdc');
  const hybridClaude = path.join(ROOT, '.claude/skills/plaid-workhorse-slides/SKILL.md');
  const hybridCursor = path.join(ROOT, '.cursor/skills/plaid-workhorse-slides/SKILL.md');
  const workhorseClaude = path.join(ROOT, '.claude/skills/tosea-slide-workhorse/SKILL.md');
  const workhorseCursor = path.join(ROOT, '.cursor/skills/tosea-slide-workhorse/SKILL.md');
  assert.ok(fs.existsSync(claudePath), 'Claude SKILL.md must exist');
  assert.ok(fs.existsSync(cursorPath), 'Cursor mirror SKILL.md must exist');
  assert.ok(fs.existsSync(cursorRule), 'Cursor .mdc rule must exist');
  assert.ok(fs.existsSync(hybridClaude), 'Hybrid Claude skill must exist');
  assert.ok(fs.existsSync(hybridCursor), 'Hybrid Cursor mirror must exist');
  assert.ok(fs.existsSync(workhorseClaude), 'Workhorse Claude skill must exist');
  assert.ok(fs.existsSync(workhorseCursor), 'Workhorse Cursor mirror must exist');

  const cursorMd = fs.readFileSync(cursorPath, 'utf8');
  assert.match(cursorMd, /^---/, 'Cursor mirror must have YAML frontmatter');
  assert.match(cursorMd, /name: plaid-slide-design/, 'Cursor mirror name must match');
  assert.match(cursorMd, /\.claude\/skills\/plaid-slide-design\/SKILL\.md/,
    'Cursor mirror must point at canonical Claude SKILL.md');

  const ruleMd = fs.readFileSync(cursorRule, 'utf8');
  assert.match(ruleMd, /globs:/, 'Cursor rule must list globs for auto-attach');
  assert.match(ruleMd, /templates\/slide-template/, 'Globs must cover slide templates');
  assert.match(ruleMd, /post-slides\.js/, 'Globs must cover post-slides');
});
