# Slide Templates — upload contract

The dashboard's **Slide Templates** subtab lets you upload either an HTML
file or an image and have it appear in the slide library that the
storyboard's `+ Insert library slide` modal reads from. To make sure the
preview iframe renders your slide correctly (and that the AI editor
inside the subtab doesn't break the splice contract), the upload
endpoint accepts files following one of these two patterns.

---

## Pattern A — Plaid slide framework (recommended)

This is what the existing built-in slides
(`signal-insight`, `auth-insight`, `identity-match-insight`) use.

The dashboard's preview is engineered to "wake up" slides authored
against this framework — entrance animations play on load, score
cards count up to their `data-target`, and reveal-on-cue chrome
(badges, overlays) lands on its final state.

### Required structure

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Slide Title</title>
  <style>
    /* All CSS inline. No external <link rel="stylesheet"> — the dashboard
       can't proxy external stylesheets through to the iframe. */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      min-width: 1440px;       /* slides are authored at 1440×900 native viewport */
      min-height: 100vh;
      font-family: system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
    }
    body { position: relative; }

    /* The slide root — Plaid's animated step container. */
    .step {
      display: none;
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      width: 100%; min-height: 100vh;
      opacity: 0; transform: translateX(24px);
      transition: opacity 0.4s, transform 0.4s;
    }
    .step.active { display: flex; opacity: 1; transform: translateX(0); }

    /* Inner content can use any of these reveal-class patterns;
       the preview will auto-add `.revealed` so they fade in: */
    .score-card { opacity: 0; transform: translateY(10px); transition: opacity 0.4s, transform 0.4s; }
    .score-card.revealed { opacity: 1; transform: translateY(0); }
    .core-attr { opacity: 0; transform: translateY(10px); transition: opacity 0.4s, transform 0.4s; }
    .core-attr.revealed { opacity: 1; transform: translateY(0); }

    /* Style your own classes freely — design tokens to match Plaid: */
    .insight-layout {
      width: 100%; min-height: 100vh;
      background: linear-gradient(135deg, #0d1117, #0a2540);
      display: flex; flex-direction: column; color: #fff;
    }
  </style>
</head>
<body>
  <!-- Required: ONE outer .step div with a unique data-testid. -->
  <div data-testid="step-my-slide-id" class="step">
    <div class="insight-layout">
      <h1>My Slide Title</h1>
      <!-- Reveal-class items render their final state in preview: -->
      <div class="score-card" data-target="42">
        <div class="score-card-label">My Score</div>
        <div class="score-card-value" data-count="0">0</div>
        <!-- The preview replaces "0" with "42" automatically. -->
      </div>
    </div>
  </div>
</body>
</html>
```

### What happens at preview time

The dashboard injects a tiny CSS+JS block into the served response
(NOT into the on-disk file) that:

| What you wrote                                                 | What preview shows                                         |
|----------------------------------------------------------------|------------------------------------------------------------|
| `<div class="step">…</div>`                                    | Adds `.active` so the step is visible.                     |
| `<div class="score-card" data-target="42">`                    | Adds `.revealed` so it fades in to its final state.        |
| `<div class="score-card-value" data-count="0">0</div>`         | Replaces `0` with `42` (the parent's `data-target`).       |
| `<div class="score-badge accept" style="opacity:0">…</div>`    | Forces opacity to 1 and clears the inline transform.       |

When the same slide is later spliced into a per-run demo app via
the storyboard's `+ Insert library slide` modal, the on-disk HTML is
used as-is — so the host's actual nav JS controls the entrance
animation timing in production. The preview override only applies
to the dashboard's preview iframe.

---

## Pattern B — Static HTML (custom class names OK)

If you don't want to follow the Plaid framework, that's fine — just
**don't use animation off-stage states**. Render the final state directly.

### Allowed
```html
<!doctype html>
<html><head>
  <style>
    body { background: #fff; padding: 48px; font-family: system-ui; }
    .hero { font-size: 48px; color: #00A67E; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    .card { background: #f5f5f5; padding: 24px; border-radius: 8px; }
  </style>
</head>
<body>
  <div data-testid="step-static-slide" class="step">
    <h1 class="hero">My static slide</h1>
    <div class="grid">
      <div class="card">Card A</div>
      <div class="card">Card B</div>
    </div>
  </div>
</body></html>
```

### NOT allowed (will render invisible / partial)
- `display: none` on custom class names — the preview won't auto-show
  these because doing so would break legitimate hide/show toggles on
  modals, dropdowns, etc.
- `visibility: hidden` — same reason.

### Auto-revealed regardless of class name
- Any element with computed `opacity: 0` is force-shown after first
  paint by a catch-all walker. Custom reveal-class patterns (e.g.
  `.fade-in`, `.entry-card`, `.scroll-reveal`) work without being in
  the explicit allow-list. Only translate/scale transforms are reset
  alongside the opacity force; rotation/skew transforms are preserved
  so legitimate rotation animations (spinners, clock hands) aren't
  clobbered.
- External `<link rel="stylesheet" href="https://...">` or
  `<script src="https://...">` — the iframe is same-origin only and
  can't fetch external resources.
- JS-driven dynamic content (charts, fetch calls, etc.) — there's no
  guarantee the host environment is what your script expects.

---

## Required outer-div contract (both patterns)

Whichever pattern you choose, your slide MUST have exactly ONE outer
`<div>` carrying:

```html
<div data-testid="step-<your-slide-id>" class="step …">
   <!-- slide content -->
</div>
```

Why: the splice helper that inserts your slide into a per-run demo app
(`spliceLibrarySlideIntoRunHtml`) finds the outer div by its
`data-testid="step-…"` attribute and merges the `.step` class with the
host's existing step framework. If you drop either, the slide won't
splice cleanly and the AI editor will reject it with
`missing-step-container`.

---

## Image uploads (PNG / JPG / WebP / GIF)

Image uploads work just like HTML uploads — the dashboard generates a
wrapper HTML for you that places the image full-bleed inside a
`.step.slide-root` container. You don't author anything; just upload
the file. The wrapper handles the contract on your behalf.

---

## When in doubt

Use the **AI chat editor** at the bottom of the Slide Templates preview
pane to ask for visual changes ("make the title teal", "tighten the
spacing under the header by 16px", etc.). The editor produces output
that conforms to Pattern A automatically and is `.bak`'d before each
write so you can recover.

For HTML you're authoring by hand or copying from another tool, the
fastest validation is: **upload it, click it in the list, and see if
the preview iframe renders what you expect.** If it's blank or partial,
check this contract — you're almost certainly hitting Pattern B's
forbidden-list (off-stage opacity:0 or display:none).
