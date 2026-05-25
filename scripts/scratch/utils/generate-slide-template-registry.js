#!/usr/bin/env node
'use strict';

/**
 * Regenerate templates/slide-template/slide-template-registry.json from showcase/index.html.
 *
 * Usage: node scripts/scratch/utils/generate-slide-template-registry.js
 */

const fs = require('fs');
const path = require('path');
const {
  parseShowcaseIndexHtml,
  getShowcaseIndexPath,
  getRegistryPath,
  PROJECT_ROOT,
} = require('./slide-template-registry');

function main() {
  const projectRoot = PROJECT_ROOT;
  const indexPath = getShowcaseIndexPath(projectRoot);
  const outPath = getRegistryPath(projectRoot);
  if (!fs.existsSync(indexPath)) {
    console.error(`[generate-slide-template-registry] Missing ${indexPath}`);
    process.exit(1);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const templates = parseShowcaseIndexHtml(html);
  if (templates.length === 0) {
    console.error('[generate-slide-template-registry] Parsed zero templates — check showcase/index.html');
    process.exit(1);
  }
  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'templates/slide-template/showcase/index.html',
      templateCount: templates.length,
    },
    templates,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[generate-slide-template-registry] Wrote ${templates.length} templates → ${path.relative(projectRoot, outPath)}`);
}

if (require.main === module) {
  main();
}

module.exports = { main };
