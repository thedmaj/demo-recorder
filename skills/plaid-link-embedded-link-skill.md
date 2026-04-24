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

## Build Requirements

- Add in-page container `data-testid="plaid-embedded-link-container"` in launch step.
- Mount Embedded Link with `Plaid.createEmbedded(...)`.
- Keep normal Link callbacks (`onSuccess`, `onExit`, `onEvent`, `onLoad`).
- Avoid hosted redirect/new-tab flows in embedded mode.
