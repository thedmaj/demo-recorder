'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOD = path.join(__dirname, '../../scripts/scratch/utils/figma-conversion');
const {
  buildFigmaConversionPrompt,
  summarizeBrand,
  summarizeStep,
  extractStepHtmlChunk,
} = require(MOD);

function seedRun(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'scratch-app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'artifacts', 'brand'), { recursive: true });
  const demoScript = overrides.demoScript || {
    buildMode: 'app-only',
    plaidLinkMode: 'embedded',
    product: 'Plaid Auth',
    persona: { name: 'Jane Doe', role: 'CFO', company: 'AcmeCo' },
    steps: [
      {
        id: 'home',
        label: 'Home',
        sceneType: 'host',
        visualState: 'Hero banner with CTA',
        narration: 'Jane opens Acme.',
        durationMs: 5000,
      },
      {
        id: 'link-launch',
        label: 'Launch Plaid Link',
        sceneType: 'link',
        visualState: 'Plaid Link embedded widget visible',
        narration: 'She clicks connect.',
      },
      {
        id: 'value-summary',
        label: 'Value summary slide',
        sceneType: 'slide',
        visualState: 'Dark slide with teal chrome',
        narration: 'Plaid Auth verifies routing + account numbers.',
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'demo-script.json'), JSON.stringify(demoScript, null, 2));
  const html =
    (overrides.html ??
      `<html><body>
<div data-testid="step-home" class="step active">
  <h1>Hello Jane</h1>
  <button>Connect account</button>
</div>
<div data-testid="step-link-launch" class="step">
  <div class="plaid-link-embed"></div>
</div>
<div data-testid="step-value-summary" class="slide-root">
  <h2>Plaid Auth</h2>
</div>
<!-- SIDE PANELS -->
<div id="api-response-panel" style="display:none"></div>
</body></html>`);
  fs.writeFileSync(path.join(dir, 'scratch-app', 'index.html'), html);
  const brand = overrides.brand || {
    name: 'AcmeCo',
    slug: 'acmeco',
    mode: 'light',
    colors: {
      bgPrimary: '#ffffff',
      accentCta: '#0052cc',
      textPrimary: '#111827',
    },
    typography: { fontHeading: 'Inter', fontBody: 'Inter' },
    logo: { light: 'https://cdn/acme-light.png' },
    hostBanner: { bg: '#ffffff', logoTone: 'dark', contrastRatio: 21 },
  };
  fs.writeFileSync(path.join(dir, 'artifacts', 'brand', 'acmeco.json'), JSON.stringify(brand, null, 2));
  return { demoScript, brand };
}

function mkTmpRun(name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-conv-'));
  const dir = path.join(base, name || 'run-1');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('figma-conversion helpers', () => {
  test('summarizeBrand normalizes colors + hostBanner', () => {
    const out = summarizeBrand({
      name: 'Foo',
      colors: { bgPrimary: '#fff', accentCta: '#000' },
      hostBanner: { bg: '#fff', logoTone: 'dark' },
    });
    assert.equal(out.name, 'Foo');
    assert.equal(out.colors.bgPrimary, '#fff');
    assert.equal(out.hostBanner.logoTone, 'dark');
  });

  test('summarizeStep classifies insight as slide', () => {
    const out = summarizeStep({ id: 's', label: 'L', sceneType: 'insight' }, 3);
    assert.equal(out.index, 4);
    assert.equal(out.stepKind, 'slide');
  });

  test('summarizeStep defaults sceneType host to app', () => {
    const out = summarizeStep({ id: 's', label: 'L' }, 0);
    assert.equal(out.stepKind, 'app');
  });

  test('extractStepHtmlChunk isolates one step and truncates when too long', () => {
    const html =
      `<div data-testid="step-a" class="step">A content</div>` +
      `<div data-testid="step-b" class="step">B content</div>` +
      `<!-- SIDE PANELS --><div id="api-response-panel"></div>`;
    const a = extractStepHtmlChunk(html, 'a');
    assert.ok(/A content/.test(a));
    assert.ok(!/B content/.test(a));
    const b = extractStepHtmlChunk(html, 'b');
    assert.ok(/B content/.test(b));
    assert.ok(!/api-response-panel/.test(b));
    const big = '<div data-testid="step-c" class="step">' + 'x'.repeat(10000) + '</div>';
    const trimmed = extractStepHtmlChunk(big, 'c', 500);
    assert.ok(trimmed.length <= 500 + 50);
    assert.match(trimmed, /truncated for prompt budget/);
  });
});

describe('buildFigmaConversionPrompt', () => {
  test('throws when run dir missing', () => {
    assert.throws(() => buildFigmaConversionPrompt('/nonexistent/run'), /runDir not found/);
  });

  test('throws when scratch-app/index.html is missing', () => {
    const dir = mkTmpRun();
    fs.writeFileSync(path.join(dir, 'demo-script.json'), JSON.stringify({ steps: [] }));
    assert.throws(() => buildFigmaConversionPrompt(dir), /scratch-app\/index\.html not found/);
  });

  test('builds a self-contained prompt with setup, skills, brand, and per-step blocks', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { promptMarkdown, summary } = buildFigmaConversionPrompt(dir, {});
    // Anchors that the agent should see:
    assert.match(promptMarkdown, /SETUP — Figma MCP plugin/);
    // Skill names + tool name (same in Cursor and Claude Code):
    assert.match(promptMarkdown, /figma-use/);
    assert.match(promptMarkdown, /figma-generate-design/);
    assert.match(promptMarkdown, /use_figma/);
    assert.match(promptMarkdown, /One frame per step/);
    // Brand block serialized as JSON, not hardcoded in text:
    assert.match(promptMarkdown, /"slug": "acmeco"/);
    // Each step has its own block:
    assert.match(promptMarkdown, /### 1\. `home`/);
    assert.match(promptMarkdown, /### 2\. `link-launch`/);
    assert.match(promptMarkdown, /### 3\. `value-summary`/);
    // Narration block present but marked as voiceover-only:
    assert.match(promptMarkdown, /do NOT render in the Figma frame/);
    // Verification checklist exists:
    assert.match(promptMarkdown, /VERIFICATION CHECKLIST/);
    // Summary stats:
    assert.equal(summary.stepCount, 3);
    assert.equal(summary.appSteps, 2);   // home + link-launch
    assert.equal(summary.slideSteps, 1); // value-summary
    assert.equal(summary.brand, 'AcmeCo');
    assert.equal(summary.target, 'new-file');
  });

  test('SETUP section covers both Cursor and Claude Code installation paths', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { promptMarkdown } = buildFigmaConversionPrompt(dir, {});
    // Cursor-side path:
    assert.match(promptMarkdown, /\*\*Cursor:\*\*/);
    assert.match(promptMarkdown, /\/add-plugin figma/);
    // Claude Code path:
    assert.match(promptMarkdown, /\*\*Claude Code:\*\*/);
    assert.match(promptMarkdown, /claude plugin install figma@claude-plugins-official/);
    assert.match(promptMarkdown, /\/mcp/);
    // Single underlying plugin / MCP — both clients hit the same remote MCP server:
    assert.match(promptMarkdown, /https:\/\/mcp\.figma\.com\/mcp/);
    // Body is agent-agnostic — it doesn't say "Cursor will…" except inside the Cursor sub-section:
    assert.doesNotMatch(promptMarkdown, /open this file in Cursor in \*\*Agent mode\*\*/i);
  });

  test('honors FIGMA_FILE_URL option', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    const { promptMarkdown, summary } = buildFigmaConversionPrompt(dir, {
      figmaFileUrl: 'https://www.figma.com/file/ABC/Demo',
    });
    assert.equal(summary.target, 'existing-file');
    assert.match(promptMarkdown, /https:\/\/www\.figma\.com\/file\/ABC\/Demo/);
  });

  test('falls back to brand-extract.json when artifacts/brand is empty', () => {
    const dir = mkTmpRun();
    seedRun(dir);
    // Wipe the artifacts/brand dir, drop a legacy brand-extract.json at run root:
    fs.rmSync(path.join(dir, 'artifacts', 'brand'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(dir, 'brand-extract.json'),
      JSON.stringify({ name: 'LegacyBrand', slug: 'legacy', colors: { bgPrimary: '#000' } })
    );
    const { summary } = buildFigmaConversionPrompt(dir);
    assert.equal(summary.brand, 'LegacyBrand');
  });
});
