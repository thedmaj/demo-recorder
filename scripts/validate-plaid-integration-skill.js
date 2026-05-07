#!/usr/bin/env node
/**
 * Validates presence + checksum of skills/plaid-integration.skill (pipeline-injected bundle).
 * Optional: --smoke-askbill runs one AskBill query when MCP is configured (slow).
 *
 * Usage: node scripts/validate-plaid-integration-skill.js [--smoke-askbill]
 */
'use strict';

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

try {
  const { loadRepoEnv } = require(path.join(PROJECT_ROOT, 'scripts/scratch/utils/dotenv-loader.js'));
  loadRepoEnv(PROJECT_ROOT, { override: false });
} catch (_) {}

const { getDefaultSkillZipPath, sha256File } = require('./scratch/utils/plaid-skill-loader');

function main() {
  const smoke = process.argv.includes('--smoke-askbill');
  const zipPath = getDefaultSkillZipPath();
  const fs = require('fs');
  if (!fs.existsSync(zipPath)) {
    console.error(`[validate-plaid-skill] Missing bundle: ${zipPath}`);
    process.exit(1);
  }
  const sha = sha256File(zipPath);
  console.log(`[validate-plaid-skill] Bundle: ${zipPath}`);
  console.log(`[validate-plaid-skill] SHA256: ${sha}`);

  if (smoke) {
    const { askPlaidDocs } = require('./scratch/utils/mcp-clients');
    console.log('[validate-plaid-skill] Running AskBill smoke question…');
    const t0 = Date.now();
    askPlaidDocs('Reply with one sentence: what is Plaid Link?', { answerFormat: 'prose' })
      .then((text) => {
        console.log(`[validate-plaid-skill] AskBill OK (${Date.now() - t0}ms): ${String(text).slice(0, 200)}…`);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`[validate-plaid-skill] AskBill smoke failed: ${err.message}`);
        process.exit(2);
      });
    return;
  }
  process.exit(0);
}

main();
