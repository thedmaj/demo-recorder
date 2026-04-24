'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mod = require(path.join(__dirname, '../../scripts/scratch/utils/product-vp-freshness'));
const {
  normalizeSlug,
  parseFrontmatter,
  serializeFrontmatter,
  extractSectionByHeading,
  replaceSectionByHeading,
  readProductMarkdown,
  writeProductMarkdown,
  describeProductVpFreshness,
  isProductVpFresh,
  stampVpResearchDate,
  upsertValuePropositionsSection,
  slugToPath,
  VP_SECTION_HEADING,
} = mod;

// Use a dedicated test slug so we never collide with real product files.
// Clean up after each test to keep the working tree pristine.
const TEST_SLUG = '__vp-freshness-test';
const TEST_FILE = slugToPath(TEST_SLUG);

afterEach(() => {
  try { fs.unlinkSync(TEST_FILE); } catch (_) {}
});

describe('product-vp-freshness — pure helpers', () => {
  test('normalizeSlug strips plaid- prefix and .md suffix', () => {
    assert.equal(normalizeSlug('auth'), 'auth');
    assert.equal(normalizeSlug('plaid-auth'), 'auth');
    assert.equal(normalizeSlug('plaid-auth.md'), 'auth');
    assert.equal(normalizeSlug('Plaid Auth'), 'auth');
    assert.equal(normalizeSlug('cra-base-report'), 'cra-base-report');
    assert.equal(normalizeSlug('plaid-cra-base-report.md'), 'cra-base-report');
    assert.equal(normalizeSlug(null), '');
    assert.equal(normalizeSlug(''), '');
  });

  test('parseFrontmatter reads scalar + array + quoted values', () => {
    const md = [
      '---',
      'product: "Plaid Foo"',
      'slug: foo',
      'last_vp_research: "2026-04-10"',
      'needs_review: true',
      'api_endpoints:',
      '  - "/link/token/create"',
      '  - "/foo/get"',
      '---',
      '',
      '# Heading',
      'body text',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(md);
    assert.equal(frontmatter.product, 'Plaid Foo');
    assert.equal(frontmatter.slug, 'foo');
    assert.equal(frontmatter.last_vp_research, '2026-04-10');
    assert.equal(frontmatter.needs_review, 'true');
    assert.deepEqual(frontmatter.api_endpoints, ['/link/token/create', '/foo/get']);
    assert.ok(body.includes('# Heading'));
  });

  test('parseFrontmatter returns empty when no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('just a body\n');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, 'just a body\n');
  });

  test('serializeFrontmatter produces parseable YAML', () => {
    const out = serializeFrontmatter({
      product: 'Plaid Foo',
      slug: 'foo',
      last_vp_research: '2026-04-10',
      version: 1,
      needs_review: true,
      items: ['a', 'b'],
    });
    const reparsed = parseFrontmatter(out + 'body\n');
    assert.equal(reparsed.frontmatter.product, 'Plaid Foo');
    assert.equal(reparsed.frontmatter.slug, 'foo');
    assert.equal(reparsed.frontmatter.last_vp_research, '2026-04-10');
    assert.deepEqual(reparsed.frontmatter.items, ['a', 'b']);
  });

  test('extractSectionByHeading finds markdown section up to next ## heading', () => {
    const body = [
      '# Title',
      '',
      '## A',
      'alpha body',
      '',
      '## B',
      'beta body',
      '',
      '## C',
      'gamma body',
    ].join('\n');
    assert.equal(extractSectionByHeading(body, '## A'), 'alpha body');
    assert.equal(extractSectionByHeading(body, '## B'), 'beta body');
    assert.equal(extractSectionByHeading(body, '## C'), 'gamma body');
    assert.equal(extractSectionByHeading(body, '## Missing'), null);
  });

  test('replaceSectionByHeading replaces existing section content', () => {
    const body = '## A\nold\n\n## B\nkeep\n';
    const updated = replaceSectionByHeading(body, '## A', 'new content');
    assert.ok(updated.includes('## A\nnew content'));
    assert.ok(updated.includes('## B\nkeep'), 'other sections must remain');
    assert.ok(!/old/.test(updated), 'old content must be gone');
  });

  test('replaceSectionByHeading appends section when missing', () => {
    const body = '# Title\n\n## A\nalpha\n';
    const updated = replaceSectionByHeading(body, '## New', 'fresh body');
    assert.ok(updated.includes('## A\nalpha'), 'existing sections preserved');
    assert.ok(/## New\nfresh body/.test(updated), 'new section appended');
  });
});

describe('product-vp-freshness — file I/O helpers', () => {
  test('writeProductMarkdown + readProductMarkdown round-trip', () => {
    const fm = { product: 'Plaid Test', slug: TEST_SLUG, last_vp_research: '2026-04-24', version: 1 };
    const body = '# Plaid Test\n\n## Overview\nTest body.\n';
    const file = writeProductMarkdown(TEST_SLUG, fm, body);
    assert.ok(fs.existsSync(file));
    const reread = readProductMarkdown(TEST_SLUG);
    assert.equal(reread.slug, TEST_SLUG);
    assert.equal(reread.frontmatter.last_vp_research, '2026-04-24');
    assert.ok(reread.body.includes('## Overview'));
  });

  test('readProductMarkdown returns null for missing file', () => {
    assert.equal(readProductMarkdown(TEST_SLUG), null);
  });

  test('describeProductVpFreshness: file-missing', () => {
    const res = describeProductVpFreshness(TEST_SLUG);
    assert.equal(res.fresh, false);
    assert.equal(res.reason, 'file-missing');
  });

  test('describeProductVpFreshness: no-vp-section', () => {
    writeProductMarkdown(
      TEST_SLUG,
      { product: 'Plaid Test', slug: TEST_SLUG, last_vp_research: '2026-04-24', version: 1 },
      '# Plaid Test\n\n## Overview\nNo VPs here.\n'
    );
    const res = describeProductVpFreshness(TEST_SLUG);
    assert.equal(res.fresh, false);
    assert.equal(res.reason, 'no-vp-section');
  });

  test('describeProductVpFreshness: stale', () => {
    writeProductMarkdown(
      TEST_SLUG,
      { product: 'Plaid Test', slug: TEST_SLUG, last_vp_research: '2020-01-01', version: 1 },
      `# Plaid Test\n\n${VP_SECTION_HEADING}\n- Solid elevator pitch text that passes the min-length check.\n`
    );
    const res = describeProductVpFreshness(TEST_SLUG, { now: new Date('2026-04-24') });
    assert.equal(res.fresh, false);
    assert.equal(res.reason, 'stale');
    assert.ok(res.ageDays > 30);
    assert.equal(res.vpSectionPresent, true);
  });

  test('describeProductVpFreshness + isProductVpFresh: fresh', () => {
    writeProductMarkdown(
      TEST_SLUG,
      { product: 'Plaid Test', slug: TEST_SLUG, last_vp_research: '2026-04-20', version: 1 },
      `# Plaid Test\n\n${VP_SECTION_HEADING}\n- Primary pitch line with enough text.\n`
    );
    const res = describeProductVpFreshness(TEST_SLUG, { now: new Date('2026-04-24') });
    assert.equal(res.fresh, true);
    assert.equal(res.reason, 'ok');
    assert.ok(res.ageDays < 30);
    assert.equal(isProductVpFresh(TEST_SLUG, { now: new Date('2026-04-24') }), true);
    assert.equal(isProductVpFresh(TEST_SLUG, { now: new Date('2026-06-01') }), false);
  });

  test('stampVpResearchDate updates frontmatter without touching body', () => {
    writeProductMarkdown(
      TEST_SLUG,
      { product: 'Plaid Test', slug: TEST_SLUG, version: 1 },
      `# Plaid Test\n\n${VP_SECTION_HEADING}\n- body content\n`
    );
    const before = fs.readFileSync(TEST_FILE, 'utf8');
    assert.ok(!/last_vp_research/.test(before));
    const { dateIso } = stampVpResearchDate(TEST_SLUG, { now: new Date('2026-04-24T12:00:00Z') });
    assert.equal(dateIso, '2026-04-24');
    const after = fs.readFileSync(TEST_FILE, 'utf8');
    assert.ok(/last_vp_research: "?2026-04-24"?/.test(after), 'date written');
    assert.ok(after.includes(VP_SECTION_HEADING), 'body preserved');
    assert.ok(after.includes('body content'), 'body preserved');
  });

  test('upsertValuePropositionsSection creates file when missing', () => {
    assert.equal(fs.existsSync(TEST_FILE), false);
    const result = upsertValuePropositionsSection(TEST_SLUG, '- Fresh VP line one.\n- Fresh VP line two.', {
      now: new Date('2026-04-24T00:00:00Z'),
    });
    assert.equal(result.created, true);
    assert.equal(result.dateIso, '2026-04-24');
    const content = fs.readFileSync(result.filePath, 'utf8');
    assert.ok(content.includes(VP_SECTION_HEADING), 'section written');
    assert.ok(content.includes('Fresh VP line one'), 'content written');
    assert.ok(/last_vp_research: "?2026-04-24"?/.test(content), 'date stamped');
  });

  test('upsertValuePropositionsSection replaces existing section and updates date', () => {
    writeProductMarkdown(
      TEST_SLUG,
      { product: 'Plaid Test', slug: TEST_SLUG, last_vp_research: '2020-01-01', version: 1 },
      `# Plaid Test\n\n${VP_SECTION_HEADING}\n- old VP\n\n## Other\nkeep me\n`
    );
    upsertValuePropositionsSection(TEST_SLUG, '- new VP one\n- new VP two', {
      now: new Date('2026-04-24T00:00:00Z'),
    });
    const content = fs.readFileSync(TEST_FILE, 'utf8');
    assert.ok(content.includes('new VP one'), 'new VPs written');
    assert.ok(!/old VP/.test(content), 'old VPs removed');
    assert.ok(/## Other\nkeep me/.test(content), 'other sections preserved');
    assert.ok(/last_vp_research: "?2026-04-24"?/.test(content), 'date updated');
  });
});
