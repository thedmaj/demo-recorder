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
    workhorseTemplateCatalog: path.join(brief, 'WORKHORSE_TEMPLATE_CATALOG.md'),
    slideTemplateRegistry: path.join(base, 'slide-template-registry.json'),
    showcaseIndexHtml: path.join(base, 'showcase', 'index.html'),
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
  // Caps raised 2026-07-09 (constraint-balance plan R1): the old 8,000-char
  // hybrid cap silently dropped the tail of plaid-workhorse-slides (10,155
  // chars) — incl. its canvas + export rules — from EVERY post-slides prompt,
  // and the 28,000 total clipped the merged text (~34.7k). Truncation is now
  // loudly logged so a growing skill can never silently lose canonical rules.
  const hybridMax = Number(opts.workhorseHybridMaxChars || process.env.PLAID_WORKHORSE_SKILL_MAX_CHARS || 12000);
  const catalogMax = Number(opts.workhorseCatalogMaxChars || process.env.PLAID_WORKHORSE_CATALOG_MAX_CHARS || 5000);
  let text = readUtf8(paths.skillMarkdown).trim();
  const hybrid = readUtf8(paths.workhorseHybridMarkdown).trim();
  const catalog = readUtf8(paths.workhorseTemplateCatalog).trim();
  const maxChars = Number(
    opts.maxChars ||
      process.env.SLIDE_DESIGN_SKILL_MAX_CHARS ||
      // Headroom so the primary plaid-slide-design skill (now carries the
      // authoritative intent→template map) does not truncate the secondary
      // workhorse hybrid + catalog off the end of the merged text.
      (hybrid.length > 0 ? 38000 : 24000)
  );
  const warnTruncated = (label, fullLen, cap) => {
    console.warn(
      `[slide-design-skill] TRUNCATION: ${label} is ${fullLen} chars but the cap is ${cap} — ` +
      `its tail will NOT reach the slide model. Trim the file or raise the cap.`
    );
  };
  const skillLoaded = text.length > 0;
  if (hybrid) {
    let hybridBlock = hybrid;
    if (hybridBlock.length > hybridMax) {
      warnTruncated('plaid-workhorse-slides SKILL.md', hybridBlock.length, hybridMax);
      hybridBlock = `${hybridBlock.slice(0, Math.max(0, hybridMax - 80))}\n\n… [plaid-workhorse-slides SKILL.md truncated]\n`;
    }
    text = text ? `${text}\n\n---\n\n${hybridBlock}` : hybridBlock;
  }
  if (catalog) {
    let catalogBlock = catalog;
    if (catalogBlock.length > catalogMax) {
      warnTruncated('WORKHORSE_TEMPLATE_CATALOG.md', catalogBlock.length, catalogMax);
      catalogBlock = `${catalogBlock.slice(0, Math.max(0, catalogMax - 80))}\n\n… [WORKHORSE_TEMPLATE_CATALOG.md truncated]\n`;
    }
    text = text ? `${text}\n\n---\n\n## Workhorse template catalog\n${catalogBlock}` : catalogBlock;
  }
  if (text.length > maxChars) {
    warnTruncated('merged slide design skill text', text.length, maxChars);
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
