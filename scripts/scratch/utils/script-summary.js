'use strict';
/**
 * script-summary.js
 *
 * Renders a high-level human-readable summary of a generated
 * demo-script.json. Used at the post-script handoff checkpoint so the
 * agent supervisor can show the operator the storyboard the LLM
 * actually produced before the pipeline burns minutes on build + QA.
 *
 * Public API:
 *   buildScriptSummary(demoScript, { runId, productFamily, buildMode })
 *     → returns a markdown string
 */

function clip(s, n = 80) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function wordCount(s) {
  return String(s || '').split(/\s+/).filter(Boolean).length;
}

function beatKind(step) {
  if (step.sceneType === 'slide') return 'slide';
  if (step.plaidPhase === 'launch') return 'link';
  return 'host';
}

function endpointOf(step) {
  return step.apiResponse && step.apiResponse.endpoint
    ? step.apiResponse.endpoint
    : '';
}

function listProducts(steps) {
  const products = new Set();
  for (const s of steps) {
    const ep = endpointOf(s);
    if (/\/link\/token\/create\b/i.test(ep) || s.plaidPhase === 'launch') products.add('Link');
    if (/\/auth\/get\b/i.test(ep)) products.add('Auth');
    if (/\/identity\/match\b/i.test(ep)) products.add('Identity Match');
    if (/\/identity\/get\b/i.test(ep)) products.add('Identity');
    if (/\/signal\/evaluate\b/i.test(ep)) products.add('Signal');
    if (/\/transfer\/authorization\/create\b/i.test(ep)) products.add('Transfer (authorization)');
    if (/\/transfer\/create\b/i.test(ep)) products.add('Transfer');
    if (/\/cra\/check_report\b/i.test(ep)) products.add('CRA');
    if (/\/credit\/(?:bank_income|payroll_income)\/get\b/i.test(ep)) products.add('Income');
    if (/\/investments\b/i.test(ep)) products.add('Investments');
    if (/\/liabilities\b/i.test(ep)) products.add('Liabilities');
    if (/\/protect\/(event\/send|user\/insights\/get)\b/i.test(ep)) products.add('Protect');
  }
  return Array.from(products);
}

function totalDuration(steps) {
  return steps.reduce((sum, s) => {
    const ms = Number(s.durationMs ?? s.durationHintMs ?? 0);
    return sum + (Number.isFinite(ms) ? ms : 0);
  }, 0);
}

function buildScriptSummary(demoScript, ctx = {}) {
  const steps = Array.isArray(demoScript?.steps) ? demoScript.steps : [];
  const runId = ctx.runId || demoScript?.meta?.runId || '(unknown run)';
  const productFamily = ctx.productFamily || demoScript?.meta?.productFamily || '(unspecified)';
  const buildMode = ctx.buildMode || (steps.some((s) => s.sceneType === 'slide') ? 'app+slides' : 'app-only');

  const products = listProducts(steps);
  const counts = steps.reduce((acc, s) => {
    const k = beatKind(s);
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const totalMs = totalDuration(steps);
  const totalSec = (totalMs / 1000).toFixed(0);
  const totalWords = steps.reduce((sum, s) => sum + wordCount(s.narration), 0);

  const lines = [];
  lines.push(`# Script summary — ${runId}`);
  lines.push('');
  lines.push(`**Build mode:** ${buildMode}`);
  lines.push(`**Product family:** ${productFamily}`);
  lines.push(`**Products featured:** ${products.join(', ') || '(none detected)'}`);
  lines.push(`**Beat count:** ${steps.length}  ·  host=${counts.host || 0}, link=${counts.link || 0}, slide=${counts.slide || 0}`);
  lines.push(`**Estimated demo length:** ~${totalSec}s  ·  ${totalWords} narration words`);
  lines.push('');
  lines.push('## Storyboard');
  lines.push('');
  lines.push('| # | Type | Step id | Narration |');
  lines.push('|---|------|---------|-----------|');
  steps.forEach((s, i) => {
    const kind = beatKind(s);
    const id = s.id || s.stepId || '?';
    const narration = clip(s.narration, 120);
    lines.push(`| ${i + 1} | ${kind} | \`${id}\` | ${narration} |`);
  });
  lines.push('');

  const apiSteps = steps.filter((s) => endpointOf(s));
  if (apiSteps.length > 0) {
    lines.push('## API panels');
    lines.push('');
    for (const s of apiSteps) {
      lines.push(`- \`${s.id}\` → **${endpointOf(s)}**`);
    }
    lines.push('');
  }

  const launch = steps.find((s) => s.plaidPhase === 'launch');
  if (launch) {
    lines.push(`## Plaid Link step`);
    lines.push('');
    lines.push(`- Step id: \`${launch.id}\``);
    lines.push(`- Plaid phase: \`launch\``);
    const flow = demoScript?.plaidSandboxConfig?.plaidLinkFlow || '(unspecified)';
    lines.push(`- Flow type: \`${flow}\``);
    const institution = demoScript?.plaidSandboxConfig?.institution || '(unspecified)';
    lines.push(`- Sandbox institution: \`${institution}\``);
    lines.push('');
  }

  const persona = demoScript?.persona;
  if (persona) {
    lines.push('## Persona');
    lines.push('');
    lines.push(`- Name: ${persona.name || '(unset)'}`);
    if (persona.role) lines.push(`- Role: ${persona.role}`);
    if (persona.company) lines.push(`- Company: ${persona.company}`);
    lines.push('');
  }

  lines.push('## What changes if you confirm');
  lines.push('');
  lines.push('The pipeline continues through `brand-extract → prompt-fidelity-check → script-critique → data-realism-check → embed-script-validate → build → plaid-link-qa → build-qa` (and `post-slides` when `app+slides`). Build alone typically takes 4–8 minutes.');
  lines.push('');
  lines.push('## What changes if you modify');
  lines.push('');
  lines.push('Describe the change in free text via the "Modify" option. Your instructions are appended to `inputs/prompt.txt` under a `### Operator modifications` block, the script stage re-runs, and you see a fresh summary on the same checkpoint.');
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  buildScriptSummary,
  // exposed for tests
  _internal: { clip, wordCount, beatKind, endpointOf, listProducts, totalDuration },
};
