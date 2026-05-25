#!/usr/bin/env node
'use strict';

/**
 * simulate-product-knowledge.js
 *
 * Standalone CLI for assessing — and optionally auto-building — a per-product
 * knowledge file at inputs/products/plaid-{slug}.md.
 *
 *   node scripts/scratch/simulate-product-knowledge.js --slug=protect
 *   node scripts/scratch/simulate-product-knowledge.js --slug=protect --auto-build
 *   node scripts/scratch/simulate-product-knowledge.js --slug=cra-base-report --dry-run
 *
 * Flags:
 *   --slug=<name>     (required) slug or filename — "protect", "plaid-protect", "plaid-protect.md"
 *   --auto-build      run the Glean-driven gap fill against any missing sections
 *   --dry-run         force dry-run mode (no mutation). Default when --auto-build is omitted.
 *
 * Side effects:
 *   - Prints a human-readable coverage table to stdout.
 *   - Writes out/simulations/{slug}-pk-{timestamp}.json with the coverage
 *     report + (when --auto-build) the build result + reassessment.
 *   - In --auto-build mode: snapshots the live PK file to
 *     inputs/products/_backups/{slug}-{ts}.md.bak before any mutation.
 *
 * Setting `PIPELINE_RUN_DIR` is optional — the simulator writes its own
 * artifacts under `out/simulations/`. It does NOT require an active pipeline
 * run.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const SIM_DIR = path.join(PROJECT_ROOT, 'out', 'simulations');

const {
  assessProductKnowledgeCoverage,
  formatCoverageReport,
} = require('./utils/product-knowledge-coverage');
const { buildProductKnowledge } = require('./utils/product-knowledge-builder');
const { normalizeSlug } = require('./utils/product-vp-freshness');

function parseArgs(argv) {
  const out = { slug: '', autoBuild: false, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--slug=')) out.slug = a.slice('--slug='.length);
    else if (a === '--auto-build') out.autoBuild = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.dryRun) out.autoBuild = false;
  return out;
}

function usage() {
  console.log(
    'Usage: node scripts/scratch/simulate-product-knowledge.js --slug=<name> [--auto-build | --dry-run]\n\n' +
    'Examples:\n' +
    '  node scripts/scratch/simulate-product-knowledge.js --slug=protect\n' +
    '  node scripts/scratch/simulate-product-knowledge.js --slug=protect --auto-build\n' +
    '  node scripts/scratch/simulate-product-knowledge.js --slug=cra-base-report --dry-run\n'
  );
}

function sanitizeTimestamp(iso) {
  return String(iso).replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.slug) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const slug = normalizeSlug(args.slug);
  console.log(`\n=== Product knowledge simulation — slug: ${slug} ===\n`);

  // BEFORE
  const before = assessProductKnowledgeCoverage({ productSlug: slug });
  console.log(formatCoverageReport(before));
  console.log('');

  let buildResult = null;
  let after = null;

  if (args.autoBuild && before.missingSections.length > 0) {
    console.log(`Auto-build enabled — Glean will fill ${before.missingSections.length} missing section(s): ${before.missingSections.join(', ')}\n`);
    try {
      buildResult = await buildProductKnowledge({
        productSlug: slug,
        coverage: before,
        dryRun: false,
      });
      console.log(
        `Build result: added=${buildResult.sectionsAdded.length} skipped=${buildResult.skippedSections.length} ` +
        `backup=${buildResult.backupPath ? path.relative(PROJECT_ROOT, buildResult.backupPath) : '(none)'}\n`
      );
      if (buildResult.sectionsAdded.length > 0) {
        for (const s of buildResult.sectionsAdded) {
          console.log(`  + ${s.section}: ${s.bulletCount} bullet(s) under "${s.heading}"`);
        }
      }
      if (buildResult.skippedSections.length > 0) {
        console.log('');
        for (const s of buildResult.skippedSections) {
          console.log(`  - ${s.section}: ${s.reason}`);
        }
      }
      console.log('');

      after = assessProductKnowledgeCoverage({ productSlug: slug });
      console.log('=== After auto-build ===\n');
      console.log(formatCoverageReport(after));
      console.log('');
    } catch (err) {
      console.error(`Auto-build failed: ${err.message}`);
      buildResult = { error: err.message };
    }
  } else if (args.autoBuild) {
    console.log('Auto-build skipped — coverage shows no missing sections.\n');
  } else {
    console.log('Dry-run mode (no mutation). Pass --auto-build to fill gaps via Glean.\n');
  }

  // Write artifact.
  fs.mkdirSync(SIM_DIR, { recursive: true });
  const ts = sanitizeTimestamp(new Date().toISOString());
  const outFile = path.join(SIM_DIR, `${slug}-pk-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    slug,
    timestamp: ts,
    autoBuild: args.autoBuild,
    dryRun: !args.autoBuild,
    before,
    buildResult,
    after,
  }, null, 2));
  console.log(`Wrote ${path.relative(PROJECT_ROOT, outFile)}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
