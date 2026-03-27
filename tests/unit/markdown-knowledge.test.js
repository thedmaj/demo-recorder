'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const mk = require(path.join(__dirname, '../../scripts/scratch/utils/markdown-knowledge'));

describe('markdown-knowledge', () => {
  test('parseFrontmatter supports CRLF delimiter', () => {
    const content = '---\r\nslug: test\r\nneeds_review: true\r\n---\r\n# Hi';
    const fm = mk.parseFrontmatter(content);
    assert.equal(fm.slug, 'test');
    assert.equal(fm.needs_review, 'true');
  });

  test('extractFactsFromMarkdown finds bullets and draft flag', () => {
    const md = '---\n---\n\n## Claims\n\n- Approved line\n\n- [DRAFT] New line\n';
    const { facts } = mk.extractFactsFromMarkdown(md);
    assert.ok(facts.length >= 2);
    const draft = facts.find(f => f.text.includes('New line'));
    assert.ok(draft);
    assert.equal(draft.draft, true);
  });

  test('applyFactOperation approve strips DRAFT marker', () => {
    const lines = ['---', '---', '', '- [DRAFT] hello', ''];
    const content = lines.join('\n');
    const lineStart = 4;
    const out = mk.applyFactOperation(content, { op: 'approve', lineStart });
    assert.ok(out.includes('- hello'));
    assert.ok(!out.includes('[DRAFT]'));
  });

  test('computeStaleness flags old last_human_review', () => {
    const old = new Date();
    old.setDate(old.getDate() - 100);
    const iso = old.toISOString().split('T')[0];
    const { staleByAge, staleDays } = mk.computeStaleness(
      { last_human_review: iso },
      { staleDaysThreshold: 90 }
    );
    assert.equal(staleByAge, true);
    assert.ok(staleDays >= 90);
  });
});
