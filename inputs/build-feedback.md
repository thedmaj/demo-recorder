# Human Review Feedback
Generated: 2026-03-14  |  Run: 2026-03-14-layer-v4

> This file is read by the build stage when running a refinement pass.
> Edit or delete it between runs as needed.

## CRITICAL: Add External Account — Missing CTA Button (persists across 3 builds)

The "Link Your Bank" CTA button KEEPS DISAPPEARING in recorded frames. The card renders body copy
but no button is visible at the bottom. This is a BLOCKER. Rules:
- Card must use height:auto, overflow:visible — never fixed height
- Button MUST be inside the card below body copy, always rendered in the DOM
- `data-testid="link-external-account-btn"`, Chime green (#1EC677), full-width
- onclick: `if (window._plaidHandler) window._plaidHandler.open()`
- Do NOT use position:absolute for the button

## CRITICAL: Closing Summary — All 3 Cards Must Show Immediately

In closing-summary, the Signal card is absent in start/mid frames. ALL THREE CARDS must be
visible with zero animation delay. Do not stagger entrance animations. Use CSS animations only
if they complete within 0.1s, or use no animation at all.

## CRITICAL: Insight Steps — Call _showApiPanelStub() in goToStep Handler

For auth-insight, identity-match-insight, signal-insight: the goToStep handler MUST call
`_showApiPanelStub(data)` with the actual API response data object. Do NOT leave the handler empty.
Example:
```
if (id === 'auth-insight') {
  _showApiPanelStub({ accounts: [{ name: 'Checking', mask: '0000', balances: { available: 4215.82, current: 4415.82 }, routing_numbers: [{ value: '021000021', type: 'ach' }] }] });
}
```

## Per-Step Visual Notes

### chime-funding-success (funds-available step)

No API JSON panel. Institution name MUST come from window._plaidInstitutionName (not hardcoded).
Account name from window._plaidAccountName, mask from window._plaidAccountMask.

### insight-auth-get

Show complete account and routing numbers without masking. Account Name, Type (Checking),
current ($4,415.82) and available ($4,215.82) balance. Call _showApiPanelStub() in goToStep.

### insight-identity-match

Comparison table MUST show numeric scores: Name: 80 (teal), Address: 90, Phone: 80, Email: 0 (amber).

### insight-signal-evaluate

Return risk scores under 19. Call _showApiPanelStub() in goToStep with signal/evaluate response.

### outcome-value / closing-summary

Use 97%+ coverage instead of 95. All 3 product cards must be immediately visible (no stagger).
