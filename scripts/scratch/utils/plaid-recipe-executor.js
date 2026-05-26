'use strict';
/**
 * plaid-recipe-executor.js
 *
 * Layer 2 of the Plaid Link recipe system. Reads a hand-authored (or
 * manually-recorded) recipe from inputs/plaid-recipes/{flow}.json and
 * drives the Plaid Link iframe screen-by-screen using its deterministic
 * selectors + per-screen dwell timing.
 *
 * Priority: this is the PRIMARY automation path when a recipe exists.
 * Vision-fallback (BrowserAgent) only fires on a per-action miss, and
 * winning fallback selectors are appended to recipe.candidateSelectors[]
 * so the operator can promote them to primarySelectors after one
 * verified run.
 *
 * Public API:
 *   loadRecipe(flowType)                              -> recipe | null
 *   resolveTemplate(value, recipe)                    -> string
 *   executeRecipe({ page, recipe, hooks, markPlaidStep, runDir }) -> telemetry
 *   appendCandidateSelector(recipe, runDir, candidate) -> void
 *
 * Recipe schema: inputs/plaid-recipes/README.md.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const RECIPES_DIR = path.join(PROJECT_ROOT, 'inputs', 'plaid-recipes');

// Default wait budgets. Per-screen dwellBeforeMs/dwellAfterMs come from the
// recipe; these are only used when the recipe omits them.
const DEFAULT_ARRIVAL_TIMEOUT_MS = 12000;
const DEFAULT_TRANSITION_TIMEOUT_MS = 8000;
const DEFAULT_OPTIONAL_SCREEN_TIMEOUT_MS = 3500;

function loadRecipe(flowType) {
  if (!flowType) return null;
  const p = path.join(RECIPES_DIR, `${flowType}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const recipe = JSON.parse(raw);
    recipe.__filePath = p;
    return recipe;
  } catch (err) {
    console.warn(`[recipe] Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function resolveTemplate(value, recipe) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, dotted) => {
    const parts = dotted.split('.');
    let cur = recipe;
    for (const seg of parts) {
      if (cur && typeof cur === 'object' && seg in cur) cur = cur[seg];
      else return '';
    }
    return cur == null ? '' : String(cur);
  });
}

function resolveSelector(targetKey, screen) {
  if (!screen?.primarySelectors) return targetKey;
  return screen.primarySelectors[targetKey] || targetKey;
}

async function waitForArrival(page, frame, signals, timeoutMs) {
  if (!Array.isArray(signals) || signals.length === 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sig of signals) {
      if (sig.type === 'frameLocator' && sig.selector) {
        try {
          const loc = frame.locator(sig.selector).first();
          const visible = await loc.isVisible({ timeout: 800 }).catch(() => false);
          if (visible) return true;
        } catch (_) {}
      } else if (sig.type === 'pageLocator' && sig.selector) {
        try {
          const loc = page.locator(sig.selector).first();
          const visible = await loc.isVisible({ timeout: 800 }).catch(() => false);
          if (visible) return true;
        } catch (_) {}
      } else if (sig.type === 'successFlag') {
        const flagged = await page.evaluate(() => !!window._plaidLinkComplete).catch(() => false);
        if (flagged) return true;
      } else if (sig.type === 'plaidEvent' && sig.name) {
        const count = await page.evaluate((name) =>
          (window._plaidEventCounts && window._plaidEventCounts[name]) || 0,
          sig.name).catch(() => 0);
        if (count >= (sig.minCount || 1)) return true;
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitForTransition(page, frame, signals, timeoutMs) {
  return waitForArrival(page, frame, signals, timeoutMs);
}

async function checkSkipIf(page, frame, signals) {
  if (!Array.isArray(signals) || signals.length === 0) return false;
  for (const sig of signals) {
    if (sig.type === 'frameLocator' && sig.selector) {
      const visible = await frame.locator(sig.selector).first().isVisible({ timeout: 500 }).catch(() => false);
      if (visible) return true;
    } else if (sig.type === 'pageLocator' && sig.selector) {
      const visible = await page.locator(sig.selector).first().isVisible({ timeout: 500 }).catch(() => false);
      if (visible) return true;
    } else if (sig.type === 'successFlag') {
      const flagged = await page.evaluate(() => !!window._plaidLinkComplete).catch(() => false);
      if (flagged) return true;
    }
  }
  return false;
}

async function tryClick(frame, selector) {
  try {
    const loc = frame.locator(selector).filter({ visible: true }).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await loc.click({ force: true, timeout: 5000 });
      return true;
    }
  } catch (_) {}
  // Plaid sometimes ships text-anchored buttons better matched via getByText.
  if (!selector.startsWith('button') && !selector.includes(':has-text') && !selector.includes('[')) {
    try {
      const loc = frame.getByText(selector, { exact: false }).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ force: true, timeout: 5000 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function tryFill(frame, selector, value) {
  try {
    const loc = frame.locator(selector).filter({ visible: true }).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
      await loc.click({ force: true, timeout: 2000 }).catch(() => {});
      await loc.fill(String(value));
      return true;
    }
  } catch (_) {}
  return false;
}

async function executeAction(action, screen, recipe, page, frame, telemetry) {
  const t0 = Date.now();
  const primaryKey = action.target;
  const primarySelector = resolveSelector(primaryKey, screen);
  const fallbackKeys = Array.isArray(action.fallbackTargets) ? action.fallbackTargets : [];
  const candidateSelectors = [primarySelector, ...fallbackKeys.map((k) => resolveSelector(k, screen))];

  if (action.dwellBeforeMs && action.dwellBeforeMs > 0) {
    await page.waitForTimeout(action.dwellBeforeMs);
  }

  let winner = null;
  let winnerKind = null; // 'primary' | 'fallback' | 'vision'

  if (action.type === 'click') {
    for (let i = 0; i < candidateSelectors.length; i++) {
      const sel = candidateSelectors[i];
      if (await tryClick(frame, sel)) {
        winner = sel;
        winnerKind = i === 0 ? 'primary' : 'fallback';
        break;
      }
    }
  } else if (action.type === 'fill') {
    const value = resolveTemplate(action.value, recipe);
    for (let i = 0; i < candidateSelectors.length; i++) {
      const sel = candidateSelectors[i];
      if (await tryFill(frame, sel, value)) {
        winner = sel;
        winnerKind = i === 0 ? 'primary' : 'fallback';
        break;
      }
    }
  } else if (action.type === 'wait') {
    winnerKind = 'wait';
    winner = '(wait)';
  } else if (action.type === 'eval') {
    try {
      await page.evaluate(new Function(action.expression));
      winnerKind = 'eval';
      winner = action.expression;
    } catch (err) {
      console.warn(`[recipe] eval failed on screen=${screen.id}: ${err.message}`);
    }
  } else {
    console.warn(`[recipe] Unknown action.type="${action.type}" on screen=${screen.id}`);
  }

  if (action.dwellAfterMs && action.dwellAfterMs > 0) {
    await page.waitForTimeout(action.dwellAfterMs);
  }

  telemetry.actions.push({
    screenId: screen.id,
    type: action.type,
    target: action.target || null,
    winner,
    winnerKind,
    candidateCount: candidateSelectors.length,
    elapsedMs: Date.now() - t0,
  });

  return { winner, winnerKind };
}

/**
 * Returns true if a recipe selector pattern would shadow the candidate.
 * Used to keep candidateSelectors[] from accumulating duplicates of
 * selectors already in primarySelectors or fallbackTargets.
 */
function recipeAlreadyHasSelector(screen, action, selector) {
  const all = new Set();
  if (screen?.primarySelectors) for (const v of Object.values(screen.primarySelectors)) all.add(String(v));
  return all.has(String(selector));
}

function appendCandidateSelector(recipe, runDir, candidate) {
  recipe.candidateSelectors = recipe.candidateSelectors || [];
  // Dedup by (screenId, actionType, selector)
  const key = `${candidate.screenId}|${candidate.actionType}|${candidate.selector}`;
  for (const c of recipe.candidateSelectors) {
    if (`${c.screenId}|${c.actionType}|${c.selector}` === key) {
      c.hitCount = (c.hitCount || 0) + 1;
      c.lastSeenAt = new Date().toISOString();
      return;
    }
  }
  recipe.candidateSelectors.push({
    ...candidate,
    pendingPromotion: true,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    hitCount: 1,
    discoveredInRun: runDir ? path.basename(runDir) : null,
  });
}

/**
 * Main entry. Drives the recipe screen-by-screen. Vision fallback is
 * delegated to `hooks.visionFallback({ screenId, actionType, hint })`
 * which the caller (record-local.js) wires to BrowserAgent. Hook is
 * optional — when omitted, missed actions just get logged.
 *
 * `markPlaidStep(stepId, page?)` from record-local.js is called at well-
 * known recipe milestones so plaid-link-timing.json gets populated.
 *
 * Returns a telemetry object describing the run for post-mortem.
 */
async function executeRecipe({ page, recipe, hooks, markPlaidStep, runDir, plaidIframeSelector }) {
  if (!recipe || !Array.isArray(recipe.screens)) {
    throw new Error('[recipe] Invalid recipe: missing screens[]');
  }
  const frame = page.frameLocator(plaidIframeSelector || 'iframe[id*="plaid-link"]');
  const telemetry = {
    flowType: recipe.flowType,
    startedAt: new Date().toISOString(),
    screensExecuted: 0,
    screensSkipped: 0,
    screensTimedOut: 0,
    actions: [],
    visionFallbacks: 0,
    candidateSelectorsAdded: 0,
    perScreen: [],
  };

  // Inject a tiny event-count shim so plaidEvent signals work even if the
  // built app didn't wire window._plaidEventCounts in onEvent.
  await page.evaluate(() => {
    if (!window._plaidEventCounts) {
      window._plaidEventCounts = {};
      const orig = window._origPlaidOnEvent;
      // The host app's onEvent already exists; recipe relies on that
      // hook also bumping _plaidEventCounts. If not present, the recipe
      // falls back to selector-based transition signals.
    }
  }).catch(() => {});

  const knownSteps = new Set(['phone-submitted', 'otp-screen', 'otp-filled', 'otp-submitted',
    'institution-list-shown', 'confirm-clicked', 'link-complete']);

  for (const screen of recipe.screens) {
    const screenStart = Date.now();
    const isOptional = !!screen.optional;

    if (await checkSkipIf(page, frame, screen.skipIf)) {
      telemetry.screensSkipped++;
      telemetry.perScreen.push({ id: screen.id, status: 'skipped-skipif', elapsedMs: Date.now() - screenStart });
      continue;
    }

    const arrivalTimeoutMs = isOptional
      ? DEFAULT_OPTIONAL_SCREEN_TIMEOUT_MS
      : (screen.arrivalTimeoutMs || DEFAULT_ARRIVAL_TIMEOUT_MS);

    const arrived = await waitForArrival(page, frame, screen.arrivalSignals, arrivalTimeoutMs);
    if (!arrived) {
      if (isOptional) {
        telemetry.screensSkipped++;
        telemetry.perScreen.push({ id: screen.id, status: 'skipped-not-arrived', elapsedMs: Date.now() - screenStart });
        continue;
      }
      telemetry.screensTimedOut++;
      telemetry.perScreen.push({ id: screen.id, status: 'arrival-timeout', elapsedMs: Date.now() - screenStart });
      console.warn(`[recipe] Screen "${screen.id}" did not arrive within ${arrivalTimeoutMs}ms — continuing best-effort.`);
      // Continue: actions may still succeed if the screen is partially loaded.
    }

    if (knownSteps.has(screen.id) && typeof markPlaidStep === 'function') {
      try { markPlaidStep(screen.id, page); } catch (_) {}
    }

    let actionsMissed = 0;
    for (const action of (screen.actions || [])) {
      const result = await executeAction(action, screen, recipe, page, frame, telemetry);
      if (!result.winner && action.type !== 'wait') {
        actionsMissed++;
        if (hooks && typeof hooks.visionFallback === 'function') {
          try {
            const fallbackHint = action.visionHint || screen.narrationHint || `${screen.id}: ${action.type} ${action.target}`;
            const visionResult = await hooks.visionFallback({
              page, frame, screenId: screen.id, actionType: action.type,
              hint: fallbackHint, recipe, action,
            });
            if (visionResult && visionResult.winnerSelector) {
              telemetry.visionFallbacks++;
              telemetry.actions[telemetry.actions.length - 1].winnerKind = 'vision';
              telemetry.actions[telemetry.actions.length - 1].winner = visionResult.winnerSelector;
              if (!recipeAlreadyHasSelector(screen, action, visionResult.winnerSelector)) {
                appendCandidateSelector(recipe, runDir, {
                  screenId: screen.id,
                  actionType: action.type,
                  originalTarget: action.target,
                  selector: visionResult.winnerSelector,
                  visionHint: fallbackHint,
                });
                telemetry.candidateSelectorsAdded++;
              }
            }
          } catch (err) {
            console.warn(`[recipe] visionFallback hook errored on screen=${screen.id}: ${err.message}`);
          }
        }
      }
    }

    // Special-case markStep emissions for symmetry with the legacy CDP path.
    if (screen.id === 'saved-institution-list' && typeof markPlaidStep === 'function') {
      try { markPlaidStep('institution-list-shown', page); } catch (_) {}
    }
    if (screen.id === 'confirm' && typeof markPlaidStep === 'function') {
      try { markPlaidStep('confirm-clicked', page); } catch (_) {}
    }

    if (Array.isArray(screen.transitionSignals) && screen.transitionSignals.length > 0) {
      const transitionTimeoutMs = screen.transitionTimeoutMs || DEFAULT_TRANSITION_TIMEOUT_MS;
      const transitioned = await waitForTransition(page, frame, screen.transitionSignals, transitionTimeoutMs);
      if (!transitioned) {
        telemetry.perScreen.push({ id: screen.id, status: 'transition-timeout',
          actionsMissed, elapsedMs: Date.now() - screenStart });
        continue;
      }
    }

    telemetry.screensExecuted++;
    telemetry.perScreen.push({
      id: screen.id,
      status: actionsMissed > 0 ? 'completed-with-misses' : 'completed',
      actionsMissed,
      elapsedMs: Date.now() - screenStart,
    });
  }

  telemetry.completedAt = new Date().toISOString();
  telemetry.totalElapsedMs = telemetry.perScreen.reduce((s, p) => s + (p.elapsedMs || 0), 0);

  // Persist telemetry alongside the run for post-mortem.
  if (runDir) {
    try {
      fs.writeFileSync(
        path.join(runDir, 'plaid-recipe-telemetry.json'),
        JSON.stringify(telemetry, null, 2),
        'utf8'
      );
    } catch (err) {
      console.warn(`[recipe] Failed to write telemetry: ${err.message}`);
    }
  }

  // Persist any new candidateSelectors back to the recipe file.
  if (telemetry.candidateSelectorsAdded > 0 && recipe.__filePath) {
    try {
      const toWrite = { ...recipe };
      delete toWrite.__filePath;
      fs.writeFileSync(recipe.__filePath, JSON.stringify(toWrite, null, 2) + '\n', 'utf8');
      console.log(`[recipe] Appended ${telemetry.candidateSelectorsAdded} candidate selector(s) to ${path.relative(PROJECT_ROOT, recipe.__filePath)}`);
    } catch (err) {
      console.warn(`[recipe] Failed to persist candidateSelectors: ${err.message}`);
    }
  }

  return telemetry;
}

module.exports = {
  loadRecipe,
  resolveTemplate,
  executeRecipe,
  appendCandidateSelector,
  // Exposed for unit tests
  _internal: { resolveSelector, recipeAlreadyHasSelector, waitForArrival, checkSkipIf },
};
