# Plaid Embedded Link Skill

Use this skill when the prompt asks for **Embedded Link** (including phrases like "Plaid in bed").

## Detection Signals

Treat Link mode as embedded when prompt/demo context includes:
- "embedded Link"
- "embedded institution search"
- "Pay by Bank embedded"
- "plaid in bed"

If not explicitly requested, default to standard Plaid modal Link.

## Product Rule

Embedded Link and Hosted Link are not the same in this pipeline:
- Embedded = in-page widget mounted in a container.
- Hosted = redirect/new-tab URL flow.

Hosted link redirects must not be used for embedded mode generation.

## Embedded Institution Search Guidance (Use This)

- Create a Link token with `/link/token/create` as normal.
- No special token parameters are required to enable Embedded Institution Search.
- If showing the "Connect Manually" choice, configure it with:
  - `auth.auth_type_select_enabled` (boolean) in your Link token config.

## Web SDK Pattern

Use an embedded container and open Link with `Plaid.createEmbedded`:

```html
<div id="plaid-embedded-link-container"></div>
```

```javascript
const embeddedLinkOpenTarget = document.querySelector('#plaid-embedded-link-container');
Plaid.createEmbedded(
  {
    token: 'GENERATED_LINK_TOKEN',
    onSuccess: (public_token, metadata) => {},
    onLoad: () => {},
    onExit: (err, metadata) => {},
    onEvent: (eventName, metadata) => {},
  },
  embeddedLinkOpenTarget
);
```

## Launch UX (Hard Rule)

In embedded mode the embedded widget IS the launch CTA. The user opens the Plaid
Link modal by clicking an institution tile inside the widget.

- Do **NOT** render any additional host-side launch button. Specifically:
  - No `<button data-testid="link-external-account-btn">` on the launch step.
  - No "Link bank account" / "Connect bank" / "Add account" / "Launch Plaid"
    button whose onclick calls `Plaid.createEmbedded`, `_plaidEmbeddedInstance.open()`,
    or a bespoke `window.launchPlaid()` wrapper.
- Trust copy ("256-bit encryption", "Plaid never stores credentials", a
  "Recommended · Instant verification via Plaid" tile) is fine — a redundant
  clickable CTA is not.

## Sizing Requirement (Single Default — All Use Cases)

Use **one** embedded container footprint for every demo (checkout, bill pay,
funding, investments move, etc.):

| Target | Value |
|--------|-------|
| Width  | **430px** (`min-width`, `max-width`, with `width: 100%` in the column) |
| Height | **390px** (`min-height` and **`height`** — same value) |

Plaid’s absolute minimum remains **350×300** or **300×350**; **430×390** satisfies that.

There are **no** small / medium / large profile variants in this pipeline — the
build normalizer always harmonizes `#plaid-embedded-link-container` to this size.

Runtime metadata (emit these globals so deterministic QA can verify sizing):

```javascript
window.__embeddedLinkUseCase = '<use-case string>';
window.__embeddedLinkSizeProfile = 'default';
window.__embeddedLinkExpectedInstitutionTileCount = <N>;
```

Do not add extra iframe/frame containment CSS to the container. In particular,
avoid `display:flex; align-items:center; justify-content:center` on the
container — that forces the widget to the middle of the box and leaves visible
whitespace below the tiles. The container should be a normal block element so
the Plaid-rendered iframe fills it naturally.

Never use `overflow: hidden` (or `overflow-x` / `overflow-y: hidden`) on
`#plaid-embedded-link-container` or on a parent that clips the launch step: the
embedded widget’s iframe is often taller than a minimal box and will be cropped.
Prefer default visible overflow, or `overflow: auto` only if you deliberately need
scrollbars. Do not cap the container with a low `max-height` unless the design
truly scrolls inside that region.

When you author CSS for `#plaid-embedded-link-container`, set
`min-width` / `min-height` **and** matching **`height`** to **430×390**.
HTML iframes use a **default height of 150px** when the host box only has `min-height` and
`height: auto`; the Plaid iframe then stays short even if the div looks tall.
Explicit `height` on the container gives the SDK a definite box so the iframe
fills the intended area (same for any `iframe { height: 100% }` helper CSS).

`width: 100%` with `max-width: 430px` is correct. The build normalizer strips
conflicting size keys, adds the missing `height`, and removes
`overflow: hidden` from that rule if present.

## Preload Guidance

- Create the embedded view before displaying it when possible to reduce latency.
- iOS: use `createEmbeddedView` and mount returned `UIView`.
- Web: use `Plaid.createEmbedded` (not `Plaid.create`) for embedded mode.
- Other platforms: create/mount embedded view per platform SDK.

## Pre-link page = live embed (HARD — parity with standard Plaid Link)

In **modal** Link, the user lands on a host pre-link page, taps a CTA, and the **real**
Plaid institution search appears. In **embedded** mode the same UX applies: the
**pre-link page shows the live Embedded Institution Search widget** — not a static
mock that defers Link to a later step.

### Required layout (one integrated launch step)

The launch step is the **full pre-link UX page**:

| Region | Content |
|--------|---------|
| Host chrome | Customer nav / logo (minimal) |
| Trust column | “Recommended · Instant verification via Plaid”, encryption bullets, consent copy |
| Embed column | **Live** `#plaid-embedded-link-container` with `Plaid.createEmbedded(...)` mounted |
| Footer | Plaid privacy policy link as needed |

- **Exactly ONE** `data-testid="plaid-embedded-link-container"` in the entire app — on this step.
- Mount the SDK when this step becomes active (or bootstrap once if the container exists only here).
- User selects an institution **inside the widget** — no extra host launch button.

### FORBIDDEN — deferred / preview-only pre-link (HARD)

Do **not** split pre-link marketing and live Link across two steps. These patterns are
**build blockers**:

- Placeholder copy such as **“Institution search preview”**, **“live Plaid Link opens on the next step”**, or any variant that tells the user Link is coming later
- A host pre-link step with a gray preview box **while** a separate bare `plaid-link-launch` step owns the real embed
- Static institution-search mocks, fake search inputs, or empty containers where the SDK should render
- Two containers with the same testid on different steps

**Wrong (two-step split):**

1. `add-external-account-embedded` — trust copy + preview placeholder *(no SDK)*
2. `plaid-link-launch` — empty embed-only page *(SDK here)*

**Correct (integrated — matches standard Link pre-link UX):**

1. `huntington-dashboard` — host overview; CTA navigates to pre-link page
2. `add-external-account-embedded` — **`sceneType: "link"`, `plaidPhase: "launch"`** — trust copy **and** live embed on the **same** step
3. *(no separate embed-only launch step)*

If the demo script already names the step `plaid-link-launch`, that step must still
include the full pre-link trust surface **plus** the live container — not a stripped
“connecting / waiting” wrapper.

### FORBIDDEN — host “Connecting / waiting” wrapper (HARD)

Recording drives the **real Plaid SDK iframe** via CDP on the launch step.

**Do NOT build on the launch step:**

- Headlines like **“Connecting your bank…”**, **“Waiting for Plaid Link to complete…”**, **“Secure session in progress”**
- Host-side loading spinners or “Active Plaid session” badges where institution search should appear
- An embed-only page with **no** pre-link trust copy (that regresses to a non-standard UX)

**`onSuccess`** → advance directly to the first post-Link host step (e.g. `verifying-account`) — no intermediate “waiting for Link” beat.

## Demo-script contract (script + record stages — HARD)

Embedded mode changes **which step is the Link launch step**. Do not reuse modal Link assumptions.

### Exactly one launch step

- **Exactly ONE** step in `demo-script.json` must have `"plaidPhase": "launch"` and `"sceneType": "link"`.
- That step is the **integrated pre-link page** (trust copy + live embed), not a bare embed-only screen.
- **Never** set `plaidPhase: "launch"` on `sceneType: "slide"` or `sceneType: "insight"` steps — those are post-Link API beats (Identity Match, Auth, Signal), not Plaid Link.
- **Never** set `plaidPhase: "launch"` on a marketing/opening slide even if copy mentions “Plaid” or “Link your bank”.

### Typical storyboard flow

| Step role | sceneType | plaidPhase | Playwright |
|-----------|-----------|------------|------------|
| Host overview / dashboard | `host` | *(omit)* | `click` on “Add external account” (or similar) CTA |
| **Pre-link + live embed (launch)** | `link` | `"launch"` | `goToStep` → this step id, `waitMs: 120000` |
| Post-Link verification / success | `host` | *(omit)* | normal host interactions |

There is **no** third “launch-only” step between pre-link and post-Link.

### Record / Playwright contract (embedded)

- Launch step `interaction.action` = **`goToStep`**, `interaction.target` = **launch step id** (the integrated pre-link step).
- **Do NOT** use `click` on `[data-testid="link-external-account-btn"]` — that selector is **modal mode only**.
- **Do NOT** add a host button whose job is to open Link; the user opens Link by selecting an institution **inside** the embedded widget (automated via CDP on the real iframe).

### Build contract (embedded)

- Mount `Plaid.createEmbedded(...)` into `data-testid="plaid-embedded-link-container"` on the **same step** that renders the pre-link trust UX.
- Container sizing: **430×390px** default (see Sizing Requirement above).

## Build Requirements

- Add in-page container `data-testid="plaid-embedded-link-container"` on the integrated pre-link launch step.
- Mount Embedded Link with `Plaid.createEmbedded(...)`.
- Keep normal Link callbacks (`onSuccess`, `onExit`, `onEvent`, `onLoad`).
- Avoid hosted redirect/new-tab flows in embedded mode.
