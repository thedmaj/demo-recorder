'use strict';

/**
 * Load the Plaid Slide Design skill for post-slides / slide-fix prompts.
 * Canonical deck briefs live under templates/slide-template/brand-design-briefs/.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DEFAULT_SKILL_REL = path.join('.claude', 'skills', 'plaid-slide-design', 'SKILL.md');
const DEFAULT_WORKHORSE_HYBRID_REL = path.join('.claude', 'skills', 'plaid-workhorse-slides', 'SKILL.md');
const SLIDE_TEMPLATE_DIR = path.join('templates', 'slide-template');
const BRIEF_DIR = path.join(SLIDE_TEMPLATE_DIR, 'brand-design-briefs');

function readUtf8(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch (_) {
    return '';
  }
}

/**
 * Absolute paths to authoritative slide design files.
 * @param {string} [projectRoot]
 */
function getSlideDesignBriefPaths(projectRoot = PROJECT_ROOT) {
  const base = path.join(projectRoot, SLIDE_TEMPLATE_DIR);
  const brief = path.join(base, 'brand-design-briefs');
  return {
    deckDesignSystem: path.join(brief, 'DECK_DESIGN_SYSTEM.md'),
    deckTemplates: path.join(brief, 'DECK_TEMPLATES.md'),
    deckComposition: path.join(brief, 'DECK_COMPOSITION.md'),
    pipelineShellRules: path.join(base, 'PIPELINE_SLIDE_SHELL_RULES.md'),
    colorsAndTypeCss: path.join(base, 'colors_and_type.css'),
    slideCss: path.join(base, 'slide.css'),
    pipelineSlideContractCss: path.join(base, 'pipeline-slide-contract.css'),
    pipelineSlideShellHtml: path.join(base, 'pipeline-slide-shell.html'),
    skillMarkdown: path.join(projectRoot, DEFAULT_SKILL_REL),
    workhorseHybridMarkdown: path.join(projectRoot, DEFAULT_WORKHORSE_HYBRID_REL),
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.projectRoot]
 * @param {number} [opts.maxChars]
 * @returns {{ text: string, skillLoaded: boolean, markdownPath: string|null, chars: number }}
 */
function loadSlideDesignSkill(opts = {}) {
  const projectRoot = opts.projectRoot || PROJECT_ROOT;
  const paths = getSlideDesignBriefPaths(projectRoot);
  const hybridMax = Number(opts.workhorseHybridMaxChars || process.env.PLAID_WORKHORSE_SKILL_MAX_CHARS || 8000);
  let text = readUtf8(paths.skillMarkdown).trim();
  const hybrid = readUtf8(paths.workhorseHybridMarkdown).trim();
  const maxChars = Number(
    opts.maxChars ||
      process.env.SLIDE_DESIGN_SKILL_MAX_CHARS ||
      (hybrid.length > 0 ? 20000 : 12000)
  );
  const skillLoaded = text.length > 0;
  if (hybrid) {
    let hybridBlock = hybrid;
    if (hybridBlock.length > hybridMax) {
      hybridBlock = `${hybridBlock.slice(0, Math.max(0, hybridMax - 80))}\n\n… [plaid-workhorse-slides SKILL.md truncated]\n`;
    }
    text = text ? `${text}\n\n---\n\n${hybridBlock}` : hybridBlock;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 80))}\n\n… [slide design skills truncated]\n`;
  }
  return {
    text,
    skillLoaded: skillLoaded || hybrid.length > 0,
    markdownPath: skillLoaded ? paths.skillMarkdown : (hybrid ? paths.workhorseHybridMarkdown : null),
    workhorseHybridLoaded: hybrid.length > 0,
    chars: text.length,
  };
}

/** Compact isolation block — always injected even when mirroring existing slides. */
const SLIDE_HOST_ISOLATION_BLOCK =
  `SLIDE vs HOST (HARD): Slides use Plaid Deck Design System tokens ONLY — never customer/host brand colors or fonts inside .slide-root. ` +
  `The customer name in prompts is for partnership copy only. Use DECK_DESIGN_SYSTEM.md palette (--plaid-ink-900, --plaid-teal-500 / #42F0CD). ` +
  `Do not copy host hex from visualState or from build-app global CSS. Mirror slide structure/template ids only — not host styling.`;

module.exports = {
  PROJECT_ROOT,
  DEFAULT_SKILL_REL,
  DEFAULT_WORKHORSE_HYBRID_REL,
  getSlideDesignBriefPaths,
  loadSlideDesignSkill,
  SLIDE_HOST_ISOLATION_BLOCK,
};
