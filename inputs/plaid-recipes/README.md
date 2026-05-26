# Plaid Link Recipes

Deterministic per-screen instructions for the recorder's Plaid Link
sub-flow. One JSON file per flow type. Recipes are the **primary** path
the recorder takes through Plaid Link — vision fallback only fires when
a recipe selector misses.

## Why this exists

Today's `record-local.js` ships hand-tuned per-screen functions
(`plaidLinkSearch`, `plaidLinkSelectInstitution`, etc.) with ranked
selector arrays inline in code. Updates require a code edit; per-screen
dwell timing is one global `PLAID_SCREEN_DWELL_MS=4000` knob.

Recipes solve both:
- **Updates are data, not code.** When Plaid's sandbox UI changes, the
  operator runs a manual record session (`pipe record-plaid-manual
  --flow=remember-me`), confirms the flow visually, and the recipe
  regenerates with new selectors + new dwell times. No code review.
- **Pause control is per-screen.** Each action carries
  `dwellBeforeMs` / `dwellAfterMs` measured from the human's actual
  pacing during the manual record. The viewer sees the OTP screen for
  the same amount of time the recording operator did, not the 4-second
  default.

## File layout

```
inputs/plaid-recipes/
  README.md                  this file
  remember-me.json           Remember-Me flow (phone +14155550011, saved institutions)
  standard.json              Standard credential flow (search, fill, MFA)   [pending Layer 1]
  oauth.json                 OAuth redirect flow (Platypus OAuth Bank)       [pending Layer 1]
  cra.json                   CRA Check / Consumer Report flow                [pending Layer 1]
```

## Schema (each recipe)

```jsonc
{
  "flowType": "remember-me",                  // matches PLAID_LINK_FLOW env value
  "institution": {                             // sandbox institution this recipe targets
    "id": "ins_109511",
    "name": "Tartan Bank",
    "isOAuth": false
  },
  "credentials": {                             // template substitution targets — referenced as ${credentials.phone}
    "phone": "+14155550011",
    "otp": "123456",
    "username": "user_good",                   // unused on Remember Me but kept for fallback
    "password": "pass_good"
  },
  "recordedAt": "<ISO8601>",
  "recordedBy": "<operator>",
  "playwrightVersion": "1.47.0",                // captured at record time
  "verifiedRuns": 0,                            // increments on each successful automated run that used this recipe end-to-end
  "lastVerifiedAt": null,                       // ISO date of most recent successful run
  "lastBrokenAt": null,                         // ISO date of most recent automation failure attributed to this recipe (selector miss, arrival timeout)
  "candidateSelectors": [],                     // vision-fallback wins not yet promoted to primary — operator/CI promotes after one verified run

  "screens": [
    {
      "id": "phone-entry",                      // matches the Plaid TRANSITION_VIEW name where possible
      "narrationHint": "Maya enters her phone number, taps Continue.",
      "primarySelectors": {                     // named so actions can reference by key (debuggable + reusable)
        "phoneInput": "input[type='tel'][autocomplete='tel']",
        "continueButton": "button:has-text('Continue')"
      },
      "actions": [
        { "type": "fill",  "target": "phoneInput",    "value": "${credentials.phone}", "dwellBeforeMs": 0,   "dwellAfterMs": 800 },
        { "type": "click", "target": "continueButton",                                  "dwellBeforeMs": 200, "dwellAfterMs": 1500 }
      ],
      "arrivalSignals": [                       // ANY of these visible = this screen is on
        { "type": "frameLocator", "selector": "input[type='tel']" }
      ],
      "transitionSignals": [                    // recorder advances to the next screen when ANY fires
        { "type": "plaidEvent", "name": "TRANSITION_VIEW", "minCount": 1 }
      ],
      "skipIf": [                               // skip the whole screen when ANY visible
        { "type": "frameLocator", "selector": "button:has-text('Continue without phone number')" }
      ]
    }
    // ... more screens
  ]
}
```

### Action types

| `type`   | Required fields                            | Behavior |
|----------|--------------------------------------------|----------|
| `click`  | `target` (selector key)                    | `frame.locator(sel).filter({visible:true}).first().click({force:true})` |
| `fill`   | `target`, `value` (literal or `${...}`)    | `loc.fill(value)` — Remember Me OTP screen auto-advances after fill |
| `wait`   | `dwellAfterMs` (the dwell IS the action)   | Pure pause; used between screens that don't advance via signal |
| `eval`   | `expression` (string of JS)                | Evaluated on host page — escape hatch for force-close, modal dismiss |

### Signal types

| `type`         | Used in                                | Resolves when |
|----------------|----------------------------------------|---------------|
| `frameLocator` | `arrivalSignals`, `skipIf`              | Selector is visible inside the Plaid iframe |
| `pageLocator`  | `arrivalSignals`, `skipIf`              | Selector visible on host page (e.g. success panel) |
| `plaidEvent`   | `transitionSignals`                    | `window._plaidTransitionCount` > minCount (set by injected onEvent shim) |
| `successFlag`  | `transitionSignals`                    | `window._plaidLinkComplete === true` |

### Dwell semantics

- `dwellBeforeMs` — pause BEFORE the action. Use when the screen needs
  to be visible for the viewer to read before the action fires (e.g.
  the OTP screen with auto-fill — let the digits be seen for ~1s).
- `dwellAfterMs` — pause AFTER the action lands but before advancing to
  the next screen. Use to let the next screen render and settle.

Total per-screen visibility = `arrival render time` + `dwellBefore(first action)`
+ `inter-action dwells` + `dwellAfter(last action)`. The recorder uses
this to plan total Plaid Link wall-clock budget against the launch
step's narration.

## Template substitution

Strings of the form `${path.to.value}` are resolved against the recipe
itself at execution time. Resolution sources, in order:
1. `recipe.credentials.*`
2. `recipe.institution.*`
3. Run-context (e.g. `${runId}`, currently informational only)

A missing path resolves to empty string with a warning in the run log.

## Recipe lifecycle

| Stage | Trigger | Who |
|-------|---------|-----|
| Author | `pipe record-plaid-manual --flow=<name>` (Layer 3, pending) | Operator clicks through Plaid Link once |
| Replay | Every automated recording | `record-local.js` recipe-first executor (Layer 2, pending) |
| Auto-candidate | Vision fallback wins on a screen with a recipe miss | Recorder appends to `candidateSelectors[]` with `pendingPromotion:true` |
| Promote | First verified automated run that uses the candidate | CI or operator flips `pendingPromotion:false` and merges into `primarySelectors` |
| Re-record | Recipe miss rate > 20% across 5 runs | Operator re-runs `record-plaid-manual` |

## See also

- `inputs/plaid-link-sandbox.md` — authoritative sandbox institutions, credentials, OTPs
- `inputs/plaid-link-nav-learnings.md` — historical run-by-run logs (raw input that seeded the first recipe)
- `scripts/scratch/utils/plaid-browser-agent.js` — vision-fallback path (only fires when recipe misses)
- `scripts/scratch/scratch/record-local.js` — recipe-first executor (Layer 2)
