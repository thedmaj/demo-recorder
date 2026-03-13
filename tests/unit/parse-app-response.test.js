'use strict';
/**
 * Tests for HTML + Playwright script extraction from a Claude build response.
 * Mirrors parseAppResponse() from scripts/scratch/scratch/build-app.js.
 * No API calls, no I/O.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const PLAYWRIGHT_MARKER = '<!-- PLAYWRIGHT_SCRIPT_JSON -->';

function stripFences(text) {
  return text
    .replace(/^```[^\n]*\n/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function parseAppResponse(raw) {
  const markerIdx = raw.indexOf(PLAYWRIGHT_MARKER);
  if (markerIdx === -1) {
    throw new Error(
      `Response missing separator "${PLAYWRIGHT_MARKER}".\n` +
      `First 300 chars: ${raw.substring(0, 300)}`
    );
  }

  let htmlPart = raw.substring(0, markerIdx).trim();
  const jsonPart = raw.substring(markerIdx + PLAYWRIGHT_MARKER.length).trim();

  htmlPart = stripFences(htmlPart);
  if (!htmlPart.startsWith('<!DOCTYPE') && !htmlPart.startsWith('<html')) {
    const doctypeIdx = htmlPart.indexOf('<!DOCTYPE');
    const htmlIdx    = htmlPart.indexOf('<html');
    const startIdx   = doctypeIdx !== -1 ? doctypeIdx : (htmlIdx !== -1 ? htmlIdx : 0);
    htmlPart = htmlPart.substring(startIdx);
  }

  let playwrightRaw = stripFences(jsonPart);
  playwrightRaw = playwrightRaw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  let playwrightScript;
  try {
    playwrightScript = JSON.parse(playwrightRaw);
  } catch (err) {
    const jsonMatch = playwrightRaw.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        playwrightScript = JSON.parse(jsonMatch[1]);
      } catch {
        throw new Error(`Could not parse playwright-script.json: ${err.message}`);
      }
    } else {
      throw new Error(`Could not parse playwright-script.json: ${err.message}`);
    }
  }

  if (!htmlPart) {
    throw new Error('HTML block is empty after separator extraction');
  }

  return { html: htmlPart, playwrightScript };
}

const VALID_HTML = `<!DOCTYPE html>
<html><head><title>Demo</title></head>
<body><div data-testid="step-intro" class="step"><h1>Hello</h1></div></body>
</html>`;

const VALID_PLAYWRIGHT = JSON.stringify({
  steps: [{ id: 'intro', interactions: [] }]
});

describe('parse-app-response', () => {
  test('valid fenced response → extracts HTML and Playwright script', () => {
    const raw = `${VALID_HTML}\n${PLAYWRIGHT_MARKER}\n${VALID_PLAYWRIGHT}`;
    const { html, playwrightScript } = parseAppResponse(raw);
    assert.ok(html.includes('<!DOCTYPE html'));
    assert.ok(Array.isArray(playwrightScript.steps));
  });

  test('missing separator → throws descriptive error', () => {
    assert.throws(
      () => parseAppResponse('<html></html>'),
      /missing separator/
    );
  });

  test('invalid JSON in Playwright block → throws', () => {
    const raw = `${VALID_HTML}\n${PLAYWRIGHT_MARKER}\n{ not valid json }`;
    assert.throws(
      () => parseAppResponse(raw),
      /Could not parse/
    );
  });

  test('HTML with markdown fences → fences stripped', () => {
    const raw = `\`\`\`html\n${VALID_HTML}\n\`\`\`\n${PLAYWRIGHT_MARKER}\n${VALID_PLAYWRIGHT}`;
    const { html } = parseAppResponse(raw);
    assert.ok(!html.startsWith('```'), 'Markdown fence should be stripped from HTML');
    assert.ok(html.includes('<!DOCTYPE html'));
  });

  test('Playwright block with ```json fence → fences stripped and parsed', () => {
    const raw = `${VALID_HTML}\n${PLAYWRIGHT_MARKER}\n\`\`\`json\n${VALID_PLAYWRIGHT}\n\`\`\``;
    const { playwrightScript } = parseAppResponse(raw);
    assert.ok(Array.isArray(playwrightScript.steps));
  });
});
