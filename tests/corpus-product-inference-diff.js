'use strict';
/**
 * Corpus over-suppression guard for the product / insight inference (Items 4a, 4b-ii).
 *
 * NOT a unit test (excluded from `node --test`, which globs tests/unit/**). Run it
 * MANUALLY before changing product-inference (`inferPlaidLinkProductsFromPrompt`)
 * or insight-classification (`isInsightLikeStep`):
 *
 *     node tests/corpus-product-inference-diff.js
 *
 * It diffs the WORKING-TREE version of the inference against the git-HEAD version
 * across every real prompt/demo-script in out/demos, isolating exactly what your
 * change alters (unlike the persisted config, which reflects each run's code at
 * the time). A clean change over-suppresses NOTHING:
 *   • products DROPPED vs HEAD  → over-suppression regression (investigate)
 *   • insight steps newly EXCLUDED (sceneType:'insight'/'slide' or untyped)
 *                                → regression; only host steps should flip
 * Requires local git history + out/demos (skips gracefully otherwise).
 *
 * Exit code: 0 if no regressions, 1 otherwise — usable as a pre-commit gate.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEMOS = path.join(ROOT, 'out', 'demos');
const UTILS = path.join(ROOT, 'scripts', 'scratch', 'utils');

function loadBaseline(relPath, tmpName) {
  // Materialize the HEAD version next to its real siblings so relative requires resolve.
  const tmp = path.join(path.dirname(path.join(ROOT, relPath)), tmpName);
  try {
    const head = execSync(`git show HEAD:${relPath}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    fs.writeFileSync(tmp, head);
    const mod = require(tmp);
    return { mod, cleanup: () => { try { fs.unlinkSync(tmp); } catch (_) {} } };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
}

if (!fs.existsSync(DEMOS)) { console.log('out/demos absent — nothing to diff. OK.'); process.exit(0); }

const nowLtc = require(path.join(UTILS, 'link-token-create-config')).inferPlaidLinkProductsFromPrompt;
const baseLtc = loadBaseline('scripts/scratch/utils/link-token-create-config.js', '_ltc_baseline_tmp.js');

let productDrops = [], productAdds = 0, scanned = 0;
if (baseLtc) {
  const base = baseLtc.mod.inferPlaidLinkProductsFromPrompt;
  for (const d of fs.readdirSync(DEMOS)) {
    const pP = path.join(DEMOS, d, 'inputs', 'prompt.txt');
    if (!fs.existsSync(pP)) continue;
    const txt = fs.readFileSync(pP, 'utf8'); scanned++;
    const b = new Set(base(txt)), a = new Set(nowLtc(txt));
    const dropped = [...b].filter((x) => !a.has(x));
    if (dropped.length) productDrops.push(`${d}: -${JSON.stringify(dropped)}`);
    if ([...a].some((x) => !b.has(x))) productAdds++;
  }
  baseLtc.cleanup();
} else {
  console.log('(could not load HEAD baseline for link-token-create-config — skipping 4b-ii diff)');
}

console.log(`Scanned ${scanned} prompts.`);
console.log(`products DROPPED vs HEAD: ${productDrops.length}`);
productDrops.forEach((x) => console.log('  ' + x));
console.log(`prompts with products ADDED vs HEAD: ${productAdds} (adds are not over-suppression; review if unexpected)`);

if (productDrops.length) {
  console.error('\nREGRESSION: the change drops products for real prompts (over-suppression). Investigate before committing.');
  process.exit(1);
}
console.log('\nOK — no over-suppression across the corpus.');
process.exit(0);
