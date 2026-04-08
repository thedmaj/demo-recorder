# Layer Mobile Mock Template Library

Use this library when building mobile-simulated Plaid Layer demos without the live SDK.

## Intent
- Keep screen 1 as host-app owned eligibility capture.
- Screens 2-4 are Layer-owned mock screens in a Plaid-style bottom sheet.
- Keep interactions deterministic for recording and QA.
- Apply brand-aware tokens so one template works across different demo brands.

## Token Map
- `{{BRAND_COMPANY}}` -> Persona company (for copy and CTA context)
- `{{BRAND_ACCENT}}` -> Extracted brand primary accent (`brand.colors.accentCta`)
- `{{CONTACT_PHONE}}` -> Persona phone/contact used in host flow
- `{{CUSTOMER_FIRST_NAME}}` -> Persona first name
- `{{CUSTOMER_FULL_NAME}}` -> Persona full name
- `{{CUSTOMER_EMAIL}}` -> Persona email (demo-safe)
- `{{CUSTOMER_ADDRESS}}` -> Persona address line (demo-safe)
- `{{BANK_NAME}}` -> Institution/account source
- `{{ACCOUNT_NAME}}` -> Account display name
- `{{ACCOUNT_MASK}}` -> Last 4 mask, format `****6789`

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
</section>
```

## Behavior Contract
- Keep all four screens in a single step container for deterministic playback.
- CTA on screen 1 advances to screen 2.
- Continue on screen 2 advances to screen 3.
- Screen 3 advances to screen 4.
- Share on screen 4 either:
  - returns to host flow step, or
  - opens next step in demo script.

## Styling Contract
- Frame target size: `390x844`.
- Host owned screen can reflect customer brand.
- Layer screens should use white bottom-sheet and Plaid-like spacing hierarchy.
- Use `{{BRAND_ACCENT}}` for action highlights so template respects per-run branding.

