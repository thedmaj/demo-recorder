'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  buildSkeletonCache,
  extractSlideRootFromSection,
  getShowcaseTemplateSkeleton,
  clearSkeletonCache,
} = require('../../scripts/scratch/utils/showcase-template-extract');
const { loadSlideTemplateRegistry } = require('../../scripts/scratch/utils/slide-template-registry');
const fs = require('fs');

const ROOT = path.join(__dirname, '../..');
const opts = { projectRoot: ROOT };

test('extracts 20 showcase skeletons from index.html', () => {
  clearSkeletonCache();
  const reg = loadSlideTemplateRegistry({ ...opts, forceReload: true });
  assert.equal(reg.templates.length, 20);
  const cache = buildSkeletonCache(ROOT);
  assert.equal(cache.size, 20);
});

test('extractSlideRootFromSection returns slide-root HTML', () => {
  const html = fs.readFileSync(
    path.join(ROOT, 'templates/slide-template/showcase/index.html'),
    'utf8'
  );
  const root = extractSlideRootFromSection(html, 'kpi-grid');
  assert.ok(root);
  assert.match(root, /class="slide-root/);
  assert.match(root, /data-workhorse-layout="kpi-grid"/);
});

test('getShowcaseTemplateSkeleton tokenizes headline placeholder', () => {
  clearSkeletonCache();
  const sk = getShowcaseTemplateSkeleton('t4-triple-stat', opts);
  assert.ok(sk);
  assert.match(sk, /\{HEADLINE\}/);
  assert.match(sk, /data-slide-template="T4"/);
});
