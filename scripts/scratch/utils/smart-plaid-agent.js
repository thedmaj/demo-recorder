'use strict';
/**
 * smart-plaid-agent.js
 *
 * Claude Sonnet-powered Plaid Link navigation agent.
 *
 * Replaces the brittle explicit-selector waterfall in record-local.js with a
 * knowledge-primed Claude Sonnet loop that observes the iframe via screenshot,
 * decides what to do, and executes CDP tool calls.
 *
 * Architecture:
 *   1. Take screenshot of current Plaid iframe state
 *   2. Send to Claude with system prompt (full knowledge base + flow config)
 *   3. Claude returns tool calls: fill | click | click_text | wait | screenshot | done
 *   4. Execute tool calls via frameLocator (CDP — bypasses cross-origin restrictions)
 *   5. Return updated screenshot as tool result → repeat (max MAX_TURNS)
 *
 * Enabled via SMART_PLAID_AGENT=true env var in record-local.js.
 *
 * Exports:
 *   SmartPlaidAgent         — class for direct use
 *   executeSmartPlaidPhase  — drop-in replacement for the CDP automation block
 */

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// ── Config ─────────────────────────────────────────────────────────────────────

const SMART_MODEL = 'claude-opus-4-7';
const MAX_TURNS   = 20;

// Knowledge base files (read at construction time)
const KNOWLEDGE_FILES = [
  path.resolve(__dirname, '../../../inputs/plaid-link-sandbox.md'),
  path.resolve(__dirname, '../../../inputs/plaid-link-nav-learnings.md'),
];

// ── SmartPlaidAgent ────────────────────────────────────────────────────────────

class SmartPlaidAgent {
  /**
   * @param {object} opts
   * @param {function} [opts.markPlaidStep]          - timing marker callback from record-local.js
   * @param {number}   [opts.PLAID_SCREEN_DWELL_MS]  - dwell ms (passed through but not used in loop)
   */
  constructor(opts = {}) {
    this._client         = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this._markPlaidStep  = opts.markPlaidStep  || (() => {});
    this._dwellMs        = opts.PLAID_SCREEN_DWELL_MS || 4000;
    this._knowledgeBase  = this._loadKnowledgeBase();
  }

  // ── Knowledge base ──────────────────────────────────────────────────────────

  _loadKnowledgeBase() {
    const parts = [];
    for (const filePath of KNOWLEDGE_FILES) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        parts.push(`## ${path.basename(filePath)}\n\n${content}`);
      } catch {
        // File may not exist in all environments — skip silently
      }
    }
    return parts.length > 0 ? parts.join('\n\n---\n\n') : '(knowledge base unavailable)';
  }

  // ── System prompt ───────────────────────────────────────────────────────────

  _buildSystemPrompt(sandboxConfig) {
    const {
      phone        = '+14155550011',
      otp          = '123456',
      username     = 'user_good',
      password     = 'pass_good',
      mfa          = '1234',
      plaidLinkFlow = 'standard',
      institutionId = 'ins_109508',
    } = sandboxConfig;

    const isRememberMe = plaidLinkFlow === 'remember-me';

    const navSequence = isRememberMe ? `
### Remember Me flow (phone: ${phone})
1. **Phone entry screen**: fill the phone input with "${phone}", then click the "Continue" button.
   - Selector: input[type="tel"], input[name="phone"], or input[placeholder*="phone" i]
   - Button: click_text("Continue") after fill — the screen does NOT auto-advance.
2. **OTP screen**: fill "input[inputmode='numeric']" with "${otp}". Wait 1000ms. The screen auto-advances.
   - Do NOT click a submit button — OTP auto-advances after the 1s pause.
3. **Saved institution list**: wait for "ul li" items to appear. Select a NON-OAuth bank.
   - Preferred order: "Tartan Bank", "First Platypus Bank", "First Gingham Credit Union"
   - AVOID: Chase, Bank of America, Wells Fargo, Citi — these are OAuth and break automation.
   - Use click_text(bankName) to select.
4. **Account selection**: click the first account row using "li[role='listitem']" (force: true).
   Then click "Confirm" button: click_text("Confirm").
5. Call done(true).` : `
### Standard flow
1. **Phone screen**: click "Continue without phone number" link — skip it.
   - Use click_text("Continue without phone number").
   - If no phone screen is visible (already on consent or search), proceed to step 2.
2. **Consent / Get started screen**: click the primary button.
   - Try: "Get started", "I agree", "Agree", "Continue", "Next" — whichever is visible.
3. **Institution search**: fill "input[placeholder*='Search' i]" with "First Platypus Bank".
   Then wait 2000ms for results to load.
4. **Select institution**: click_text("First Platypus Bank") or click first "li[role='option']".
5. **Connection type (if shown)**: click the first option — "li:first-of-type button".
6. **Credentials**: fill username "input[type='text']:first-of-type" with "${username}".
   Fill password "input[type='password']" with "${password}".
   Submit: click "button[type='submit']".
7. **MFA (if shown)**: fill "input[inputmode='numeric']" or "input[maxlength='4']" with "${mfa}".
   Then click submit button.
8. **Account selection**: click the first "li[role='listitem']" (force: true).
   Then click "Continue" button: click_text("Continue").
9. Call done(true).`;

    return `You are an expert browser automation agent completing a Plaid Link flow in sandbox mode.

You interact with the Plaid Link iframe using tool calls. After each tool call you receive an updated screenshot.
Your goal is to navigate the complete flow and call done(true) after the account selection is confirmed.

## Flow Configuration
- Flow type: ${plaidLinkFlow}
- Institution ID: ${institutionId}
- Phone: ${phone}
- Remember Me OTP: ${otp}
- Username: ${username}
- Password: ${password}
- MFA (bank OTP, 4-digit): ${mfa}

## CRITICAL RULES
1. All selectors are evaluated inside the Plaid Link iframe (frameLocator handles this automatically).
2. NEVER choose OAuth institutions (Chase, Bank of America, Wells Fargo, Citi) — they trigger a redirect that breaks automation.
3. OTP screen: fill the input and call wait(1000). Do NOT click a submit button — it auto-advances.
4. Phone screen: type number AND click Continue — it does NOT auto-advance on fill.
5. Account rows: "li[role='listitem']" is the clickable element (not the hidden checkbox inside).
6. If an action fails (error returned), take a screenshot to re-evaluate before retrying.
7. If stuck for more than 2 turns on the same screen, call done(false) with an explanation.
8. Always call done() to signal completion or failure — do not leave the loop hanging.

## Navigation Sequence
${navSequence}

## Confirmed Working Selectors (from past runs)
- Phone input: input[type="tel"]
- OTP input: input[inputmode="numeric"]  ← ALWAYS use this for OTP
- Search input: input[placeholder*="Search" i]
- Username: input[type="text"]:first-of-type
- Password: input[type="password"]
- Submit: button[type="submit"]
- Account row: li[role="listitem"]

## Knowledge Base
${this._knowledgeBase}`;
  }

  // ── Tool definitions ────────────────────────────────────────────────────────

  _getTools() {
    return [
      {
        name: 'fill',
        description: 'Fill a text input inside the Plaid Link iframe using a CSS selector',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the input element' },
            value:    { type: 'string', description: 'Value to fill into the input' },
          },
          required: ['selector', 'value'],
        },
      },
      {
        name: 'click',
        description: 'Click an element inside the Plaid Link iframe using a CSS selector',
        input_schema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the element to click' },
            force:    { type: 'boolean', description: 'Use force click if element appears non-interactive' },
          },
          required: ['selector'],
        },
      },
      {
        name: 'click_text',
        description: 'Click an element by its visible text inside the Plaid Link iframe',
        input_schema: {
          type: 'object',
          properties: {
            text:  { type: 'string',  description: 'Visible text of the element' },
            exact: { type: 'boolean', description: 'Match text exactly (default: false for partial match)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'wait',
        description: 'Wait for a number of milliseconds (max 10000)',
        input_schema: {
          type: 'object',
          properties: {
            ms: { type: 'number', description: 'Milliseconds to wait' },
          },
          required: ['ms'],
        },
      },
      {
        name: 'screenshot',
        description: 'Take a fresh screenshot of the current state for re-evaluation',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'done',
        description: 'Signal phase complete (success=true) or unrecoverable failure (success=false)',
        input_schema: {
          type: 'object',
          properties: {
            success: { type: 'boolean', description: 'True if Confirm/Continue was clicked; false if stuck' },
            reason:  { type: 'string',  description: 'What happened / why failed' },
          },
          required: ['success', 'reason'],
        },
      },
    ];
  }

  // ── Tool executor ───────────────────────────────────────────────────────────

  async _executeTool(page, toolName, toolInput) {
    const frame = page.frameLocator('iframe[id*="plaid-link"], iframe[src*="cdn.plaid.com"]');

    switch (toolName) {
      // ── fill ─────────────────────────────────────────────────────────────────
      case 'fill': {
        const { selector, value } = toolInput;

        // OTP timing markers
        const isOtp = selector && (selector.includes('inputmode') || selector.includes('numeric'));
        if (isOtp) this._markPlaidStep('otp-screen');

        try {
          const el = frame.locator(selector).first();
          await el.waitFor({ state: 'visible', timeout: 5000 });
          await el.fill(String(value), { timeout: 5000 });
          console.log(`  [SmartPlaid] fill("${selector}", "${value}")`);

          if (isOtp) {
            // OTP: mandatory 1s pause then mark — screen auto-advances
            await page.waitForTimeout(1000);
            this._markPlaidStep('otp-filled');
          }

          return { ok: true };
        } catch (e) {
          console.warn(`  [SmartPlaid] fill failed: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      // ── click ─────────────────────────────────────────────────────────────────
      case 'click': {
        const { selector, force } = toolInput;
        try {
          const el = frame.locator(selector).first();
          await el.waitFor({ state: 'visible', timeout: 5000 });
          await el.click({ force: !!force, timeout: 5000 });
          console.log(`  [SmartPlaid] click("${selector}"${force ? ', force' : ''})`);
          await page.waitForTimeout(600); // brief settle
          return { ok: true };
        } catch (e) {
          console.warn(`  [SmartPlaid] click failed: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      // ── click_text ────────────────────────────────────────────────────────────
      case 'click_text': {
        const { text, exact } = toolInput;

        // Confirm-click timing marker
        const isConfirm = /^(Confirm|Continue|Link account|Share|Done)$/i.test(text.trim());
        if (isConfirm) this._markPlaidStep('confirm-clicked');

        try {
          const el = frame.getByText(text, { exact: !!exact }).first();
          await el.waitFor({ state: 'visible', timeout: 5000 });
          await el.click({ timeout: 5000 });
          console.log(`  [SmartPlaid] click_text("${text}")`);
          await page.waitForTimeout(600);
          return { ok: true };
        } catch (e) {
          console.warn(`  [SmartPlaid] click_text failed: ${e.message}`);
          return { ok: false, error: e.message };
        }
      }

      // ── wait ──────────────────────────────────────────────────────────────────
      case 'wait': {
        const ms = Math.min(toolInput.ms || 1000, 10000);
        await page.waitForTimeout(ms);
        console.log(`  [SmartPlaid] wait(${ms}ms)`);
        return { ok: true };
      }

      // ── screenshot ────────────────────────────────────────────────────────────
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        return { ok: true, screenshot: buf };
      }

      // ── done ──────────────────────────────────────────────────────────────────
      case 'done': {
        return {
          ok:      true,
          done:    true,
          success: toolInput.success,
          reason:  toolInput.reason,
        };
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────────

  /**
   * Navigate the Plaid Link iframe from its current state through account confirmation.
   *
   * Only the 'launch' phase has CDP automation; all others are no-ops.
   *
   * @param {import('playwright').Page} page
   * @param {string} phase          e.g. 'launch'
   * @param {object} sandboxConfig  From loadSandboxConfig()
   */
  async runPhase(page, phase, sandboxConfig) {
    if (phase !== 'launch') {
      console.log(`[SmartPlaid] Phase "${phase}" — no-op (only 'launch' is handled)`);
      return;
    }

    console.log(`[SmartPlaid] Starting smart navigation (flow=${sandboxConfig.plaidLinkFlow}, model=${SMART_MODEL})`);

    const systemPrompt = this._buildSystemPrompt(sandboxConfig);
    const tools        = this._getTools();

    // Initial screenshot
    const initialBuf = await page.screenshot({ type: 'png', fullPage: false });

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: initialBuf.toString('base64') },
          },
          {
            type: 'text',
            text:
              `This is the current state of the Plaid Link modal. ` +
              `Navigate the complete ${sandboxConfig.plaidLinkFlow || 'standard'} flow ` +
              `starting from wherever the UI currently is. ` +
              `When the account selection Confirm/Continue button has been clicked, call done(true).`,
          },
        ],
      },
    ];

    let turn     = 0;
    let complete = false;

    while (turn < MAX_TURNS && !complete) {
      turn++;
      console.log(`[SmartPlaid] Turn ${turn}/${MAX_TURNS}`);

      const response = await this._client.messages.create({
        model:      SMART_MODEL,
        max_tokens: 1024,
        system:     systemPrompt,
        tools,
        messages,
      });

      console.log(`  [SmartPlaid] stop_reason=${response.stop_reason}, blocks=${response.content.length}`);

      // Add assistant message to history
      messages.push({ role: 'assistant', content: response.content });

      // ── end_turn: no tool call — prompt again with fresh screenshot ──────────
      if (response.stop_reason === 'end_turn') {
        const refreshBuf = await page.screenshot({ type: 'png', fullPage: false });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: refreshBuf.toString('base64') },
            },
            { type: 'text', text: 'Here is the current state. Please continue with the next action.' },
          ],
        });
        continue;
      }

      if (response.stop_reason !== 'tool_use') {
        console.warn(`[SmartPlaid] Unexpected stop_reason: ${response.stop_reason} — breaking`);
        break;
      }

      // ── Process tool calls ────────────────────────────────────────────────────
      const toolResults = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        const { id, name, input } = block;
        console.log(`  [SmartPlaid] → ${name}(${JSON.stringify(input).substring(0, 120)})`);

        const result = await this._executeTool(page, name, input);

        // ── done tool: signal received ──────────────────────────────────────────
        if (result.done) {
          complete = true;
          toolResults.push({
            type:        'tool_result',
            tool_use_id: id,
            content:     `Done: ${result.reason}`,
          });
          if (!result.success) {
            // Push results to history so we have full transcript, then throw
            messages.push({ role: 'user', content: toolResults });
            throw new Error(`SMART_PLAID_TIMEOUT: Agent signaled failure — ${result.reason}`);
          }
          console.log(`[SmartPlaid] ✓ Phase complete: ${result.reason}`);
          break;
        }

        // ── Capture updated screenshot for tool result ───────────────────────────
        let shotBuf;
        if (result.screenshot) {
          // screenshot tool already captured one
          shotBuf = result.screenshot;
        } else {
          // Brief settle then capture
          await page.waitForTimeout(800);
          shotBuf = await page.screenshot({ type: 'png', fullPage: false });
        }

        toolResults.push({
          type:        'tool_result',
          tool_use_id: id,
          content: [
            {
              type:   'image',
              source: { type: 'base64', media_type: 'image/png', data: shotBuf.toString('base64') },
            },
            {
              type: 'text',
              text: result.ok
                ? 'Action succeeded. Here is the updated state.'
                : `Action failed: ${result.error}. Here is the current state — please reassess.`,
            },
          ],
        });
      }

      if (!complete) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    if (!complete) {
      throw new Error(`SMART_PLAID_TIMEOUT: Max turns (${MAX_TURNS}) reached without completing phase`);
    }
  }
}

// ── Drop-in replacement function ──────────────────────────────────────────────

/**
 * Drop-in replacement for the CDP automation block in executePlaidLinkPhase.
 *
 * @param {import('playwright').Page} page
 * @param {string} phase            'launch' (others are no-ops)
 * @param {object} sandboxConfig    From loadSandboxConfig()
 * @param {object} [opts]           { markPlaidStep, PLAID_SCREEN_DWELL_MS }
 */
async function executeSmartPlaidPhase(page, phase, sandboxConfig, opts = {}) {
  const smartAgent = new SmartPlaidAgent(opts);
  return smartAgent.runPhase(page, phase, sandboxConfig);
}

module.exports = { SmartPlaidAgent, executeSmartPlaidPhase };
