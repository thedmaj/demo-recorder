# Layer Mobile Mock Template Library

Use this library when building mobile-simulated Plaid Layer demos without the live SDK.

## HARD CONTRACT (pipeline-enforced, non-negotiable)

When `shouldInjectLayerMobileMockTemplate` is true for a build (Layer + mobile-visual), the generated `index.html` **must** align with the canonical skeleton the pipeline injects into the build prompt:

- **Canonical file:** `templates/mobile-layer-mock/layer-mobile-skeleton-from-2026-03-23-layer-v2.html`
- **Structural:** Wrap steps in `.app-main`; include `data-testid="mobile-simulator-shell"` on the primary phone chrome; global fixed `data-testid="layer-eligibility-helper-text"` with both routing numbers (`415-555-1111` eligible, `415-555-0011` ineligible); mobile-runtime compatibility (`setDemoViewMode` / `mobile-shell-target`) must not be broken.
- **Layer UX:** Host eligibility first; then Plaid-style bottom sheet for **Sign up instantly** → **Authenticating your device** → **Confirm the details you want to share** → Share. Eligible path must not force PII collection before completion.
- **Plaid mark:** Use `./plaid-logo-horizontal-black-white-background.png` only (wordmark includes “Plaid”) — **no** separate “PLAID” text span beside the image.
- **Color:** Layer + host mobile accents use **only** pipeline-injected `--layer-brand-*` / `--layer-host-page-bg-*` variables (`layer-mock-brand-tokens.js`). **No** hardcoded default palette in the skeleton or generated CSS for those surfaces.
- **Host hero:** Use the **host use-case visual placeholder** pattern (`host-use-case-visual-slot` / `data-testid="host-use-case-visual-placeholder"`); do **not** hard-code a generic credit-card illustration unless the brand script explicitly requires it.
- **Deviations:** Step IDs may match `demo-script.json` (single-step multi-phase vs multi-step) only if **all** items above remain satisfied and Playwright `data-testid` uniqueness is preserved.

The build agent receives the full skeleton in-context; treat it as the source of truth for CSS patterns, runtime behavior, and DOM contracts.

## Intent
- Keep screen 1 as host-app owned eligibility capture.
- Screens 2-4 are Layer-owned mock screens in a Plaid-style bottom sheet.
- Keep interactions deterministic for recording and QA.
- Apply brand-aware tokens so one template works across different demo brands.

## Token Map
- `{{BRAND_COMPANY}}` -> Persona company (for copy and CTA context)
- `{{BRAND_ACCENT}}` -> **Copy/prompt context only** — do not paste a hardcoded accent hex into Layer/host mobile CSS. Runtime colors are **always** the pipeline-injected CSS variables below.
- `{{CONTACT_PHONE}}` -> Persona phone/contact used in host flow
- `{{CUSTOMER_FIRST_NAME}}` -> Persona first name
- `{{CUSTOMER_FULL_NAME}}` -> Persona full name
- `{{CUSTOMER_EMAIL}}` -> Persona email (demo-safe)
- `{{CUSTOMER_ADDRESS}}` -> Persona address line (demo-safe)
- `{{BANK_NAME}}` -> Institution/account source
- `{{ACCOUNT_NAME}}` -> Account display name
- `{{ACCOUNT_MASK}}` -> Last 4 mask, format `****6789`
- `{{LAYER_ELIGIBLE_PHONE}}` -> Phone number that routes to Layer-eligible path (default `415-555-1111`)
- `{{LAYER_INELIGIBLE_PHONE}}` -> Phone number that routes to ineligible fallback path (default `415-555-0011`)

## Required Screen Sequence
1. `host-eligibility` (custom app screen)
2. `layer-consent` ("Sign up instantly")
3. `layer-authenticating` ("Authenticating your device...")
4. `layer-confirm` ("Confirm the details you want to share")

## Minimal Structure
```html
<section class="layer-mobile-shell" data-testid="layer-mobile-shell">
  <div class="layer-mobile-frame">
    <div class="layer-screen is-active" data-layer-screen="host-eligibility">...</div>
    <div class="layer-screen" data-layer-screen="layer-consent">...</div>
    <div class="layer-screen" data-layer-screen="layer-authenticating">...</div>
    <div class="layer-screen" data-layer-screen="layer-confirm">...</div>
  </div>
  <p class="layer-helper-text" data-testid="layer-eligibility-helper-text">
    Use 415-555-1111 for instant Layer eligibility. Use 415-555-0011 to see ineligible fallback (PII + Plaid Link).
  </p>
</section>
```

## Behavior Contract
- Keep all four screens in a single step container for deterministic playback.
- In the host phone input (screen 1), prefill the eligible number first (`415-555-1111`).
- CTA on screen 1 advances to screen 2.
- Continue on screen 2 advances to screen 3.
- Screen 3 advances to screen 4.
- Share on screen 4 either:
  - returns to host flow step, or
  - opens next step in demo script.
- Keep helper text visible below the mobile frame in Layer experiences, showing both numbers and branch outcomes.

## Styling Contract
- Frame target size: `390x844`.
- Host owned screen can reflect customer brand layout; **accent and host page wash** must use the **injected** custom properties only (no hardcoded demo palette).
- Layer screens: white bottom-sheet, Plaid-like spacing hierarchy; CTAs and tinted surfaces use the same variables as the host mobile step.

### Color variables (pipeline-injected, no defaults in the skeleton)

On every Layer + mobile-visual build, `build-app.js` injects `<style id="layer-mock-brand-tokens">` from the **current run’s** `brand/*.json` (`scripts/scratch/utils/layer-mock-brand-tokens.js`). The generated app must reference:

| Variable | Role |
|----------|------|
| `--layer-brand-accent` | Primary CTA fills, consent icon background, bank chip, link underlines, spinner ring |
| `--layer-brand-accent-hover` | Derived in injection (`color-mix` from accent) |
| `--layer-brand-tint-bg` | Consent card fill, authenticating button bar — from `accentBgTint` when present, else `color-mix` from accent |
| `--layer-phone-input-border` | Host phone field border — from `accentBorder` when present, else `color-mix` from accent |
| `--layer-host-page-bg-from` / `--layer-host-page-bg-to` | `.layer-mobile-stage` gradient — from `bgPrimary` + `surfaceCard` / `accentBgTint` / `color-mix`; never a fixed green or Plaid teal |

**Rules:** Do not ship parallel theme variables (e.g. `--pm-primary`) for these surfaces. Do not embed hex/rgb literals for Layer mock accents in `index.html`. The canonical skeleton omits `:root` color defaults so previews rely on injection or a scratch-app build.

