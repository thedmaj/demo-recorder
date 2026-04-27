'use strict';
/**
 * figma-conversion.js
 *
 * Builds an agent-ready prompt that translates a built scratch-app demo
 * into a Figma file (one frame per demo-script step), using Cursor's
 * `plugin-figma-figma` MCP. The CLI command (`pipe figma-convert`) writes
 * this prompt to disk + copies a paste-into-agent recipe to the clipboard.
 *
 * Pure I/O helpers (no MCP / network calls happen here — the CLI cannot
 * reach Figma directly because `use_figma` is an agent-side tool. The
 * agent runs the prompt and uses the MCP from its own context.)
 *
 * Exports:
 *   buildFigmaConversionPrompt(runDir) → { promptMarkdown, summary }
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeRead(file, max = 200000) {
  try {
    const buf = fs.readFileSync(file, 'utf8');
    return max && buf.length > max ? buf.slice(0, max) : buf;
  } catch (_) {
    return '';
  }
}

function summarizeBrand(brand) {
  if (!brand || typeof brand !== 'object') return null;
  const c = brand.colors || {};
  const t = brand.typography || {};
  const hb = brand.hostBanner || null;
  return {
    name: brand.name || 'Unknown brand',
    slug: brand.slug || null,
    mode: brand.mode || 'light',
    colors: {
      bgPrimary: c.bgPrimary || '#ffffff',
      accentCta: c.accentCta || null,
      textPrimary: c.textPrimary || null,
      navBg: c.navBg || null,
      navAccentStripe: c.navAccentStripe || null,
      footerBg: c.footerBg || null,
      surfaceCard: c.surfaceCard || null,
    },
    typography: {
      fontHeading: t.fontHeading || null,
      fontBody: t.fontBody || null,
      googleFontsImport: t.googleFontsImport || null,
    },
    logo: brand.logo || null,
    hostBanner: hb,
  };
}

function summarizeStep(step, idx) {
  if (!step || typeof step !== 'object') return null;
  return {
    index: idx + 1,
    id: step.id || `step-${idx + 1}`,
    label: step.label || '',
    sceneType: step.sceneType || 'host',
    stepKind: step.stepKind || (step.sceneType === 'slide' || step.sceneType === 'insight' ? 'slide' : 'app'),
    plaidPhase: step.plaidPhase || null,
    visualState: step.visualState || '',
    narration: step.narration || '',
    durationMs: step.durationMs || step.durationHintMs || null,
    apiEndpoint: step.apiResponse && step.apiResponse.endpoint ? step.apiResponse.endpoint : null,
  };
}

/**
 * Extract the marked-up portion of one step's HTML so the agent can
 * mirror the layout faithfully in Figma. Falls back to a placeholder
 * when the step container can't be found.
 */
function extractStepHtmlChunk(html, stepId, maxChars = 6000) {
  if (!html || !stepId) return null;
  const safeId = String(stepId).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // NOTE: `$` at the end of the lookahead ensures we still extract the last
  // step in a document that has no side-panels / closing body (common in
  // hand-crafted or trimmed test fixtures).
  const re = new RegExp(
    `<div[^>]*\\bdata-testid="step-${safeId}"[^>]*>[\\s\\S]*?(?=<div[^>]*\\bdata-testid="step-|<!--[\\s\\S]*SIDE PANELS|<div[^>]*\\bid="(?:link-events-panel|api-response-panel)"|<\\/body>|$)`,
    'i'
  );
  const m = String(html).match(re);
  if (!m) return null;
  const chunk = m[0].trim();
  if (chunk.length <= maxChars) return chunk;
  return chunk.slice(0, maxChars) + '\n<!-- truncated for prompt budget -->';
}

function buildFigmaConversionPrompt(runDir, opts = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`figma-conversion: runDir not found — ${runDir}`);
  }
  const runId = path.basename(runDir);
  const scriptPath = path.join(runDir, 'demo-script.json');
  const htmlPath = path.join(runDir, 'scratch-app', 'index.html');
  if (!fs.existsSync(scriptPath)) throw new Error('figma-conversion: demo-script.json not found in run dir');
  if (!fs.existsSync(htmlPath)) throw new Error('figma-conversion: scratch-app/index.html not found in run dir — build the demo before converting');

  const demoScript = safeReadJson(scriptPath) || {};
  const html = safeRead(htmlPath, 600000); // generous; we only embed per-step chunks

  // Brand profile may live in either the new artifacts/brand layout or the
  // legacy run-root location (depending on when the run was built).
  const brandCandidates = [];
  try {
    const brandDir = path.join(runDir, 'artifacts', 'brand');
    if (fs.existsSync(brandDir)) {
      for (const f of fs.readdirSync(brandDir)) {
        if (f.endsWith('.json') && !/brand-extract\.json$/.test(f)) brandCandidates.push(path.join(brandDir, f));
      }
    }
  } catch (_) {}
  brandCandidates.push(path.join(runDir, 'brand-extract.json'));
  let brand = null;
  for (const cand of brandCandidates) {
    if (cand && fs.existsSync(cand)) {
      const j = safeReadJson(cand);
      if (j && (j.name || j.slug || j.colors)) { brand = j; break; }
    }
  }
  const brandSummary = summarizeBrand(brand);

  const steps = Array.isArray(demoScript.steps) ? demoScript.steps : [];
  const stepSummaries = steps.map(summarizeStep).filter(Boolean);
  const stepHtmlBlocks = stepSummaries.map((s) => ({
    ...s,
    html: extractStepHtmlChunk(html, s.id, 4500) || '<!-- no html extracted; reproduce layout from visualState -->',
  }));

  const figmaFileUrl = String(opts.figmaFileUrl || process.env.FIGMA_FILE_URL || '').trim();
  const figmaTeamId = String(opts.figmaTeamId || process.env.FIGMA_TEAM_ID || '').trim();
  const newFile = !figmaFileUrl;
  const targetLine = newFile
    ? '_(no FIGMA_FILE_URL set — create a new Figma file in your default team and paste the URL back when done)_'
    : `Target Figma file: \`${figmaFileUrl}\``;

  const persona = (demoScript.persona && typeof demoScript.persona === 'object') ? demoScript.persona : {};

  const promptMarkdown =
    `# Figma conversion — ${runId}\n\n` +
    `> **What this is:** an agent-ready prompt that translates a built demo app (\`scratch-app/index.html\`) ` +
    `into a Figma file with one frame per demo-script step. The agent uses the official Figma MCP ` +
    `(via the \`use_figma\` tool) to write directly into Figma — no manual layout work.\n\n` +
    `> **How to use:** open this file in your AI agent in **Agent mode** (not Ask / read-only). ` +
    `Both Cursor and Claude Code work — see SETUP below for client-specific install steps. ` +
    `Once the agent is in Agent mode, say "Run this prompt." The agent will load the required skills, ` +
    `prompt for Figma OAuth on first run, and produce the file.\n\n` +
    `---\n\n` +
    `## SETUP — Figma MCP plugin (one-time per machine)\n\n` +
    `The Figma plugin (\`figma@claude-plugins-official\`) bundles the remote Figma MCP server ` +
    `(\`https://mcp.figma.com/mcp\`), the \`use_figma\` write tool, and the skills referenced below. ` +
    `It is the same plugin in Cursor and Claude Code — only the install command differs.\n\n` +
    `**Cursor:**\n` +
    `1. In Cursor's chat, type: \`/add-plugin figma\` (or open Settings → Plugins → search "Figma" → Install).\n` +
    `2. The first time the agent calls \`use_figma\`, Cursor pops a Figma OAuth dialog. Click **Authorize**.\n` +
    `3. (Optional) Verify it's enabled: Settings → MCP / Tools → \`plugin-figma-figma\` toggled on.\n\n` +
    `**Claude Code:**\n` +
    `1. In a shell (or Claude Code's terminal): \`claude plugin install figma@claude-plugins-official\`.\n` +
    `   _Alternative — run \`/plugin install figma@claude-plugins-official\` from inside the Claude Code chat._\n` +
    `2. Restart Claude Code if it was already running, so the plugin's tools + skills register.\n` +
    `3. The first \`use_figma\` call triggers a Figma OAuth flow in your browser. Approve it.\n` +
    `4. Verify with the \`/mcp\` slash command — \`figma\` should appear in the connected list.\n\n` +
    `**Common to both clients:**\n` +
    `- (Optional) Set a default target file in your shell: ` +
    `\`export FIGMA_FILE_URL="https://www.figma.com/file/<key>/<name>"\`. ` +
    `If unset, the agent creates a new file in your default team.\n` +
    `- This run-prompt was generated by \`npm run pipe -- figma-convert ${runId}\` in the demo-recorder ` +
    `pipeline; re-run that command if the demo is rebuilt and you want a refreshed prompt.\n\n` +
    `${targetLine}\n\n` +
    `---\n\n` +
    `## REQUIRED SKILLS — load both before any \`use_figma\` calls\n\n` +
    `Both skills ship with the Figma plugin (\`figma@claude-plugins-official\`) and are available to ` +
    `Cursor and Claude Code identically. If your client is Claude Code, you can locate them under ` +
    `\`~/.claude/plugins/cache/claude-plugins-official/figma/<version>/skills/\`.\n\n` +
    `1. **\`figma-use\`** — MANDATORY prerequisite for every \`use_figma\` call. Skipping it causes hard-to-debug failures.\n` +
    `2. **\`figma-generate-design\`** — the workflow skill for translating an app/page/view into Figma. Discovers the design system, imports tokens, and assembles screens section-by-section.\n\n` +
    `Read both skills now (in this order) before generating any Figma scripts.\n\n` +
    `---\n\n` +
    `## TASK\n\n` +
    `Build a Figma file that mirrors the demo flow below. **One frame per step**, organized in a vertical grid (3 frames per row, 1440×900 each, 100px gutter). Frame names match \`<step.index>. <step.label>\` so reviewers can scan the flow at a glance.\n\n` +
    `Use the brand tokens (colors, typography, logo) from the **BRAND** section as Figma variables — do NOT hardcode hex values per shape. Add a top-level page named "${runId}" with sub-pages for "Host UI", "Plaid Link", and "Slides" (whichever apply).\n\n` +
    `For each step:\n` +
    `- Header / nav matches the host app's layout (use the HTML chunk as the source of truth for layout density).\n` +
    `- Body content reflects the step's \`visualState\`. ` +
    `Honor the **APP-ONLY rule** if \`buildMode === 'app-only'\` (no Plaid product names, score grids, or "Powered by Plaid" attribution on host frames).\n` +
    `- For \`stepKind === 'slide'\` steps, use the Plaid slide template aesthetic (dark navy bg, teal accents, mono endpoint pill in the header).\n` +
    `- Skip per-step background images / brandfetch logos that aren't present locally; instead drop in a Figma component placeholder named \`brand-logo\`.\n\n` +
    `When done, output a 1-paragraph summary of: total frames written, design tokens created, and the Figma file URL.\n\n` +
    `---\n\n` +
    `## DEMO METADATA\n\n` +
    `- **Run ID:** \`${runId}\`\n` +
    `- **Build mode:** ${demoScript.buildMode || 'app-only'}\n` +
    `- **Plaid Link mode:** ${demoScript.plaidLinkMode || 'modal'}\n` +
    `- **Product:** ${demoScript.product || '(unset)'}\n` +
    `- **Persona:** ${[persona.name, persona.role].filter(Boolean).join(' — ') || '(unset)'}\n` +
    `- **Company:** ${persona.company || '(unset)'}\n` +
    `- **Step count:** ${stepSummaries.length}\n\n` +
    `---\n\n` +
    `## BRAND\n\n` +
    (brandSummary
      ? '```json\n' + JSON.stringify(brandSummary, null, 2) + '\n```\n\n'
      : '_(brand profile not found in the run dir — derive a generic neutral palette and ask the user before using any specific brand colors.)_\n\n') +
    `---\n\n` +
    `## STEP-BY-STEP CONTRACT (read each block carefully — implement in order)\n\n` +
    stepHtmlBlocks
      .map((b) => {
        const lines = [
          `### ${b.index}. \`${b.id}\` — ${b.label || '(no label)'}`,
          ``,
          `- **Scene type:** \`${b.sceneType}\` (${b.stepKind})${b.plaidPhase ? ` · plaidPhase=\`${b.plaidPhase}\`` : ''}`,
          b.apiEndpoint ? `- **API endpoint (narration only — do NOT show on host frames):** \`${b.apiEndpoint}\`` : null,
          b.durationMs ? `- **Duration:** ${b.durationMs}ms` : null,
          ``,
          `**Visual state (what the user sees):**`,
          ``,
          b.visualState ? '> ' + b.visualState.replace(/\n/g, '\n> ') : '> _(no visualState — use the HTML chunk as ground truth)_',
          ``,
          `**Narration (do NOT render in the Figma frame — this is voiceover only):**`,
          ``,
          b.narration ? '> ' + b.narration.replace(/\n/g, '\n> ') : '> _(no narration)_',
          ``,
          `**Built HTML (truncated for prompt budget):**`,
          ``,
          '```html',
          b.html,
          '```',
          ``,
        ].filter((l) => l !== null);
        return lines.join('\n');
      })
      .join('\n---\n\n') +
    `\n\n---\n\n` +
    `## VERIFICATION CHECKLIST (run before reporting completion)\n\n` +
    `- [ ] One Figma frame per demo-script step, named \`<index>. <label>\`.\n` +
    `- [ ] Brand colors used as Figma variables, not hardcoded fills.\n` +
    `- [ ] No on-frame Plaid product names / score breakdowns / "Powered by Plaid" attribution on host frames (when \`buildMode === 'app-only'\`).\n` +
    `- [ ] Plaid Link launch step has its own frame showing the embedded widget OR a placeholder for the modal, depending on \`plaidLinkMode\`.\n` +
    `- [ ] All slide-kind steps use the dark Plaid slide aesthetic; host steps use the brand HOST APP DESIGN SYSTEM.\n` +
    `- [ ] Final response includes the Figma file URL so a reviewer can open it.\n`;

  const summary = {
    runId,
    stepCount: stepSummaries.length,
    appSteps: stepSummaries.filter((s) => s.stepKind !== 'slide').length,
    slideSteps: stepSummaries.filter((s) => s.stepKind === 'slide').length,
    brand: brandSummary ? brandSummary.name : null,
    target: figmaFileUrl ? 'existing-file' : 'new-file',
    figmaFileUrl: figmaFileUrl || null,
    figmaTeamId: figmaTeamId || null,
    promptChars: promptMarkdown.length,
  };

  return { promptMarkdown, summary };
}

module.exports = {
  buildFigmaConversionPrompt,
  // Exposed for tests:
  summarizeBrand,
  summarizeStep,
  extractStepHtmlChunk,
};
