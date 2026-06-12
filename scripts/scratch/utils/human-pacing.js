'use strict';
/**
 * human-pacing.js
 *
 * Seeded human-pacing primitives for Plaid-surface automation (Link, Embedded
 * Link, Layer, CRA Link, IDV). Makes the recorder's in-iframe behavior look
 * like a person: jittered typing cadence, read-time dwells proportional to
 * on-screen text, pre-click hesitation, list-scan pauses.
 *
 * Contract:
 *   - style 'fast'  → every method reproduces the recorder's PRE-EXISTING
 *     behavior exactly (fixed constants / plain fill); zero behavior change.
 *   - style 'human' → jittered, profile-aware pacing.
 *   - Jitter is seeded (mulberry32) by run id so a re-record of the same run
 *     reproduces identical timing. Override with PLAID_PACING_SEED.
 *
 * The pacer also keeps a per-screen ledger of applied dwells; record-local
 * writes it to plaid-pacing-manifest.json and uses dwellBudgetMs() to extend
 * the Plaid Link success timeout so added dwells never eat the budget.
 *
 * Profiles come from inputs/plaid-nav-profiles/*.json via plaid-nav-profile.js.
 * A null profile is fine — engine defaults apply.
 */

// ── Engine defaults (overridable per profile / per screen) ───────────────────
const DEFAULTS = {
  readWpm: 220,            // HCI norm 200–240 wpm
  scanFactor: 0.7,         // users scan UI; they don't read it like prose
  readDwellClampMs: [900, 6000],
  interKeyMs: [80, 150],   // generic text typing (~40–60 wpm)
  passwordInterKeyMs: [100, 180],
  numericInterKeyMs: [120, 220],
  numericChunkPauseMs: [300, 600], // OTP/phone read-back pause after digit 3–4
  preClickMs: [300, 900],
  consentPreClickMs: [600, 1200],  // legal/consent CTAs get longer deliberation
  settleMs: [250, 600],
  listScanBaseMs: [800, 1500],
  listScanPerItemMs: 150,
  listScanCapMs: 2500,
  jitterFraction: 0.4,
};

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || 'plaid-pacing');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} opts
 * @param {'fast'|'human'} [opts.style]   default from PLAID_NAV_STYLE, else 'fast'
 * @param {string} [opts.seed]            stable seed (run id); PLAID_PACING_SEED wins
 * @param {object|null} [opts.profile]    nav profile from plaid-nav-profile.js
 * @param {function} [opts.getScreenPacing] (profile, screenId) → merged pacing block
 */
function createPacer(opts = {}) {
  const style = opts.style || process.env.PLAID_NAV_STYLE || 'fast';
  const human = style === 'human';
  const seed = process.env.PLAID_PACING_SEED || opts.seed || 'plaid-pacing';
  const rand = mulberry32(hashSeed(seed));
  const profile = opts.profile || null;
  const getScreenPacing = typeof opts.getScreenPacing === 'function' ? opts.getScreenPacing : null;

  // Per-screen ledger for plaid-pacing-manifest.json + budget extension.
  const ledger = { style, seed, experience: profile?.experience || null, perScreen: {}, totalAddedMs: 0 };
  let currentScreenId = null;

  function randIn(range) {
    if (!Array.isArray(range)) return Number(range) || 0;
    const [min, max] = range;
    return Math.round(min + rand() * (max - min));
  }

  function jitter(ms) {
    const f = DEFAULTS.jitterFraction;
    return Math.max(0, Math.round(ms * (1 - f + rand() * 2 * f)));
  }

  function screenPacing(screenId) {
    const base = { ...DEFAULTS, ...(profile?.pacingDefaults || {}) };
    if (screenId && profile && getScreenPacing) {
      const sp = getScreenPacing(profile, screenId);
      if (sp) return { ...base, ...sp };
    }
    return base;
  }

  function note(screenId, kind, ms) {
    if (!human || !ms) return;
    const id = screenId || currentScreenId || '_unscoped';
    const entry = (ledger.perScreen[id] = ledger.perScreen[id] || { addedMs: 0, events: [] });
    entry.addedMs += ms;
    entry.events.push({ kind, ms });
    ledger.totalAddedMs += ms;
  }

  return {
    style,
    isHuman: human,

    /** Tag subsequent pacing events with the active Plaid screen. */
    setScreen(screenId, enteredAtMs) {
      currentScreenId = screenId || null;
      if (human && screenId) {
        const entry = (ledger.perScreen[screenId] = ledger.perScreen[screenId] || { addedMs: 0, events: [] });
        if (enteredAtMs != null && entry.enteredAtMs == null) entry.enteredAtMs = enteredAtMs;
      }
    },

    /**
     * Type into a Playwright locator (page- or frame-scoped).
     * fast: opts.fastDelayMs != null → pressSequentially({delay}) (today's OTP
     *       path); otherwise plain fill() (today's everything-else path).
     * human: per-char cadence by kind, with an OTP/phone chunk pause.
     */
    async humanType(locator, text, o = {}) {
      const value = String(text);
      if (!human) {
        // Byte-identical to pre-pacer behavior: OTP-style sites pass
        // fastDelayMs (pressSequentially), everything else used a bare fill().
        if (o.fastDelayMs != null) {
          await locator.pressSequentially(value, { delay: o.fastDelayMs });
        } else {
          await locator.fill(value);
        }
        return;
      }
      const p = screenPacing(o.screenId);
      const kind = o.kind || 'text';
      const range = kind === 'numeric' ? p.numericInterKeyMs
        : kind === 'password' ? p.passwordInterKeyMs
        : p.interKeyMs;
      await locator.click({ force: true, timeout: 2000 }).catch(() => {});
      let added = 0;
      const chunkAt = kind === 'numeric' ? 2 + Math.round(rand()) : -1; // pause after digit 3 or 4 (0-indexed)
      for (let i = 0; i < value.length; i++) {
        await locator.pressSequentially(value[i], { delay: 0 });
        if (i < value.length - 1) {
          let waitMs = randIn(range);
          if (i === chunkAt) waitMs += randIn(p.numericChunkPauseMs);
          await locator.page().waitForTimeout(waitMs);
          added += waitMs;
        }
      }
      note(o.screenId, `type:${kind}`, added);
    },

    /**
     * Screen-reading dwell. fast: returns fallbackMs unchanged (caller keeps
     * its existing constant). human: read-time model — profile readDwellMs
     * range when set, else 600 + words × (60000/wpm) × scanFactor, clamped.
     * Returns the resolved ms; does NOT wait (callers own the wait so the
     * existing dwell plumbing — interruptible waits etc. — keeps working).
     */
    screenDwellMs({ screenId, wordCount, fallbackMs } = {}) {
      if (!human) return fallbackMs != null ? fallbackMs : 0;
      const p = screenPacing(screenId);
      let ms;
      if (Array.isArray(p.readDwellMs)) {
        ms = randIn(p.readDwellMs);
      } else {
        const words = Number(wordCount) || p.typicalWordCount || 20;
        const raw = 600 + words * (60000 / p.readWpm) * p.scanFactor;
        const [lo, hi] = p.readDwellClampMs;
        ms = jitter(Math.min(hi, Math.max(lo, Math.round(raw))));
      }
      // Never under-wait a slow sandbox transition: calibration p90 is a floor.
      const p90 = profile?.screens?.find?.((s) => s.id === screenId)?.observed?.p90TransitionMs;
      if (p90 && ms < p90) ms = p90;
      note(screenId, 'readDwell', ms);
      return ms;
    },

    /** Sample a pre-click hesitation without waiting (for external dwell plumbing). */
    hesitateMs(kind = 'primary', screenId) {
      if (!human) return 0;
      const p = screenPacing(screenId);
      const ms = randIn(kind === 'consent' ? p.consentPreClickMs : p.preClickMs);
      note(screenId, `hesitate:${kind}`, ms);
      return ms;
    },

    /** Pre-click hesitation. fast: no-op. */
    async hesitate(page, kind = 'primary', screenId) {
      if (!human) return 0;
      const ms = this.hesitateMs(kind, screenId);
      await page.waitForTimeout(ms);
      return ms;
    },

    /** Post-action settle. fast: no-op (call sites keep their own constants). */
    async settle(page, screenId) {
      if (!human) return 0;
      const p = screenPacing(screenId);
      const ms = randIn(p.settleMs);
      await page.waitForTimeout(ms);
      note(screenId, 'settle', ms);
      return ms;
    },

    /**
     * Visual-search dwell over a list (institutions, accounts).
     * fast: returns 0 — callers keep their existing fixed pauses.
     */
    async scanList(page, itemCount, screenId) {
      if (!human) return 0;
      const p = screenPacing(screenId);
      const ms = Math.min(p.listScanCapMs,
        randIn(p.listScanBaseMs) + Math.max(0, Number(itemCount) || 0) * p.listScanPerItemMs);
      await page.waitForTimeout(ms);
      note(screenId, 'scanList', ms);
      return ms;
    },

    /**
     * Sample one inter-keystroke delay (ms) for keyboard-level typing where no
     * locator exists (e.g. vision-driven page.keyboard.type). fast: fixed 40ms
     * (the pre-pacer visionType constant).
     */
    interKeyDelayMs(kind = 'text', screenId) {
      if (!human) return 40;
      const p = screenPacing(screenId);
      const range = kind === 'numeric' ? p.numericInterKeyMs
        : kind === 'password' ? p.passwordInterKeyMs
        : p.interKeyMs;
      return randIn(range);
    },

    /** Total human-added ms — used to extend plaidLinkWaitSuccess's budget. */
    dwellBudgetMs() {
      return ledger.totalAddedMs;
    },

    /**
     * Merge another pacer's dwell ledger into this one. Layer/IDV launches
     * pace through a product-local pacer (their own nav profile); absorbing it
     * keeps plaid-pacing-manifest.json complete for the whole recording.
     */
    absorb(other) {
      if (!other || typeof other.manifest !== 'function') return;
      const m = other.manifest();
      for (const [id, entry] of Object.entries(m.perScreen || {})) {
        const mine = (ledger.perScreen[id] = ledger.perScreen[id] || { addedMs: 0, events: [] });
        mine.addedMs += entry.addedMs || 0;
        mine.events.push(...(entry.events || []));
        if (entry.enteredAtMs != null && mine.enteredAtMs == null) mine.enteredAtMs = entry.enteredAtMs;
      }
      ledger.totalAddedMs += m.totalAddedMs || 0;
    },

    /** Manifest payload for plaid-pacing-manifest.json. */
    manifest() {
      return { ...ledger, generatedAt: new Date().toISOString() };
    },
  };
}

module.exports = { createPacer, DEFAULTS, _internal: { mulberry32, hashSeed } };
