'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  scopeSlideCss,
  scopeCssBody,
  scopeOneSelector,
  splitSelectorList,
  splitTopLevelBlocks,
} = require(path.join(__dirname, '../../scripts/scratch/utils/slide-css-scoper'));

const SCOPE = '[data-testid="step-foo"]';

// ─── scopeOneSelector — selector-level rewriting ────────────────────────────

describe('scopeOneSelector', () => {
  test('drops html / body / :root', () => {
    assert.equal(scopeOneSelector('html', SCOPE), null);
    assert.equal(scopeOneSelector('body', SCOPE), null);
    assert.equal(scopeOneSelector(':root', SCOPE), null);
    // Compound selectors that BEGIN with body/html still drop:
    assert.equal(scopeOneSelector('body.is-dark', SCOPE), null);
    assert.equal(scopeOneSelector('html[data-x]', SCOPE), null);
  });

  test('attaches scope (no space) when selector starts with .step', () => {
    // Slide root rules — must stick to the slide div itself, not its descendants.
    assert.equal(scopeOneSelector('.step', SCOPE), `:where(${SCOPE}).step`);
    assert.equal(scopeOneSelector('.step.active', SCOPE), `:where(${SCOPE}).step.active`);
    assert.equal(scopeOneSelector('.step:hover', SCOPE), `:where(${SCOPE}).step:hover`);
  });

  test('attaches scope when selector starts with the step data-testid', () => {
    assert.equal(scopeOneSelector('[data-testid="step-foo"]', SCOPE), `:where(${SCOPE})[data-testid="step-foo"]`);
  });

  test('uses descendant scope (with space) for everything else', () => {
    assert.equal(scopeOneSelector('.score-card', SCOPE), `:where(${SCOPE}) .score-card`);
    assert.equal(scopeOneSelector('.insight-layout > h1', SCOPE), `:where(${SCOPE}) .insight-layout > h1`);
    assert.equal(scopeOneSelector('button:hover', SCOPE), `:where(${SCOPE}) button:hover`);
  });

  test('scopes universal selectors (used for resets) without dropping them', () => {
    // The slide's `*{margin:0;padding:0;box-sizing:border-box}` reset should
    // apply only to slide descendants, not the host page.
    assert.equal(scopeOneSelector('*', SCOPE), `:where(${SCOPE}) *`);
    assert.equal(scopeOneSelector('*::before', SCOPE), `:where(${SCOPE}) *::before`);
    assert.equal(scopeOneSelector('*::after', SCOPE), `:where(${SCOPE}) *::after`);
  });

  test('returns null for empty / whitespace-only selectors', () => {
    assert.equal(scopeOneSelector('', SCOPE), null);
    assert.equal(scopeOneSelector('   ', SCOPE), null);
  });

  test('does NOT confuse `.stepper` / `.steps` (compound classes that share a prefix)', () => {
    // Critical: `.step` start-anchor must stop at a class-name boundary —
    // `.stepper` is a different class and should NOT be treated as the
    // slide root. (Today's slide CSS doesn't use this, but we must not
    // regress on user-authored future slides.)
    assert.equal(scopeOneSelector('.stepper', SCOPE), `:where(${SCOPE}) .stepper`);
    assert.equal(scopeOneSelector('.steps', SCOPE), `:where(${SCOPE}) .steps`);
  });
});

// ─── splitSelectorList — comma splitting respects parens / brackets ─────────

describe('splitSelectorList', () => {
  test('splits a simple comma list', () => {
    assert.deepEqual(splitSelectorList('.a, .b, .c'), ['.a', '.b', '.c']);
  });

  test('respects parens — does not split inside :is() / :where() / :not()', () => {
    assert.deepEqual(
      splitSelectorList('.a, :is(.b, .c) > span, .d'),
      ['.a', ':is(.b, .c) > span', '.d']
    );
    assert.deepEqual(
      splitSelectorList(':not(.x, .y), .z'),
      [':not(.x, .y)', '.z']
    );
  });

  test('respects brackets — does not split inside attribute selectors', () => {
    assert.deepEqual(
      splitSelectorList('[data-x="a,b"], .y'),
      ['[data-x="a,b"]', '.y']
    );
  });

  test('drops empty entries', () => {
    assert.deepEqual(splitSelectorList('.a,,.b,'), ['.a', '.b']);
  });
});

// ─── splitTopLevelBlocks — brace tracking, strings, comments ────────────────

describe('splitTopLevelBlocks', () => {
  test('separates two adjacent rules', () => {
    const css = '.a{color:red}.b{color:blue}';
    const blocks = splitTopLevelBlocks(css);
    const rules = blocks.filter((b) => b.prelude !== null);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].prelude, '.a');
    assert.equal(rules[0].body, 'color:red');
    assert.equal(rules[1].prelude, '.b');
    assert.equal(rules[1].body, 'color:blue');
  });

  test('handles nested braces inside @media', () => {
    const css = '@media (max-width: 600px) { .a { color: red } .b { color: blue } } .c { color: green }';
    const blocks = splitTopLevelBlocks(css).filter((b) => b.prelude !== null);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].prelude, '@media (max-width: 600px)');
    assert.match(blocks[0].body, /\.a/);
    assert.match(blocks[0].body, /\.b/);
    assert.equal(blocks[1].prelude, '.c');
  });

  test('does not split on braces inside strings', () => {
    const css = '.a::before { content: "hi { there"; color: red } .b { color: blue }';
    const blocks = splitTopLevelBlocks(css).filter((b) => b.prelude !== null);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].prelude, '.a::before');
    assert.match(blocks[0].body, /content:/);
  });

  test('skips block comments', () => {
    const css = '/* leading comment */ .a { color: red } /* between */ .b { color: blue }';
    const blocks = splitTopLevelBlocks(css).filter((b) => b.prelude !== null);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].prelude, '.a');
    assert.equal(blocks[1].prelude, '.b');
  });
});

// ─── scopeCssBody — full pass over a stylesheet ─────────────────────────────

describe('scopeCssBody', () => {
  test('scopes a typical slide stylesheet (mirrors the real library file)', () => {
    const css = `
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
      html,body{width:100%;min-width:1440px;}
      body{position:relative;}
      .step{display:none;position:absolute;top:0;left:0;right:0;bottom:0;}
      .step.active{display:flex;opacity:1;}
      .insight-layout{background:#0d1117;color:#fff;}
      .score-card{padding:20px;}
    `;
    const out = scopeCssBody(css, SCOPE);

    // Universal reset is scoped to slide descendants:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \*,\s*:where\(\[data-testid="step-foo"\]\) \*::before/);
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \*::after/);

    // html / body rules dropped entirely:
    assert.doesNotMatch(out, /(?:^|\W)html\b/);
    // (`body` of the rule appears once below as ":where(scope).step.active",
    // so we assert only that no naked `body{...}` selector survived.)
    assert.doesNotMatch(out, /(?:^|\s)body\s*\{/);

    // .step / .step.active attached to the slide root, not as descendants:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\)\.step\b/);
    assert.match(out, /:where\(\[data-testid="step-foo"\]\)\.step\.active/);

    // .insight-layout and .score-card are descendant-scoped:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.insight-layout/);
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.score-card/);
  });

  test('recurses into @media bodies', () => {
    const css = '@media (min-width: 800px) { .a { color: red } html { color: blue } }';
    const out = scopeCssBody(css, SCOPE);
    // @media wrapper preserved:
    assert.match(out, /@media \(min-width: 800px\)/);
    // Inner .a got scoped:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a/);
    // Inner html got dropped:
    assert.doesNotMatch(out, /(?:^|\s)html\s*\{/);
  });

  test('preserves @keyframes verbatim (animation names are global by design)', () => {
    const css = '@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } } .a { animation: fadeIn 0.4s }';
    const out = scopeCssBody(css, SCOPE);
    // @keyframes selector lines untouched:
    assert.match(out, /@keyframes fadeIn/);
    assert.match(out, /from\s*\{\s*opacity:\s*0\s*\}/);
    assert.match(out, /to\s*\{\s*opacity:\s*1\s*\}/);
    // Outer rule scoped:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a/);
  });

  test('drops a rule entirely when ALL its selectors target html/body/:root', () => {
    const css = 'html, body, :root { background: black } .a { color: red }';
    const out = scopeCssBody(css, SCOPE);
    assert.doesNotMatch(out, /background:\s*black/);
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a/);
  });

  test('keeps a rule when SOME selectors are droppable but others are not', () => {
    const css = 'html, .a { color: red }';
    const out = scopeCssBody(css, SCOPE);
    // html dropped, .a survives and is scoped:
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a\s*\{/);
    assert.doesNotMatch(out, /(?:^|\W)html\W/);
  });

  test('returns empty string for empty input', () => {
    assert.equal(scopeCssBody('', SCOPE), '');
    assert.equal(scopeCssBody(null, SCOPE), '');
  });
});

// ─── scopeSlideCss — top-level entry point ──────────────────────────────────

describe('scopeSlideCss', () => {
  test('handles a raw CSS string', () => {
    const css = '.a { color: red }';
    const out = scopeSlideCss(css, 'foo');
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a/);
  });

  test('preserves the <style> wrapper when input is a full <style> tag', () => {
    const tag = '<style data-source="slide-lib">\n.a { color: red }\n</style>';
    const out = scopeSlideCss(tag, 'foo');
    assert.match(out, /^<style data-source="slide-lib">/);
    assert.match(out, /<\/style>$/);
    assert.match(out, /:where\(\[data-testid="step-foo"\]\) \.a/);
  });

  test('returns input unchanged when stepId is missing (defensive — never silently scope to "")', () => {
    const css = '.a { color: red }';
    assert.equal(scopeSlideCss(css, ''), css);
    assert.equal(scopeSlideCss(css, null), css);
  });

  test('returns "" for empty / non-string input', () => {
    assert.equal(scopeSlideCss('', 'foo'), '');
    assert.equal(scopeSlideCss(null, 'foo'), '');
    assert.equal(scopeSlideCss(undefined, 'foo'), '');
  });

  test('escapes double-quotes in stepId so the attribute selector stays valid', () => {
    // Pathological stepId — should be sanitized by callers anyway, but the
    // scoper must not produce broken CSS even on bad input.
    const out = scopeSlideCss('.a { color: red }', 'foo"bar');
    assert.match(out, /\[data-testid="step-foo\\"bar"\]/);
  });
});
