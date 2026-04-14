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

## Key Difference vs Standard Plaid Modal

- Standard modal flow:
  - Client initializes `Plaid.create({ token, onSuccess, onEvent, onExit })`
  - Calls `handler.open()`
  - Plaid appears in a modal iframe overlay.

- Embedded flow:
  - Server returns standard `link_token` from `/link/token/create`.
  - Client mounts in-page widget with `Plaid.createEmbedded(config, containerElement)`.
  - Widget is preloaded when launch step becomes active (not only after button click).
  - Success still uses `onSuccess` callback and should set `_plaidLinkComplete = true`.

## Build Requirements

- Add an in-page container `data-testid="plaid-embedded-link-container"` in the launch step.
- Mount Embedded Link into that container with `Plaid.createEmbedded(...)`.
- Do not call `window.open(...)` or use `hosted_link_url` in embedded mode.
- Do not add "Connect Bank Account", "Link Bank Account", or similar launch CTA buttons in embedded mode.
- Embedded launch starts from rendering/activating the container itself.
- Container-fill contract (required):
  - Container must set `position: relative; overflow: hidden; display: block; width: 100%;`
  - Container must reserve vertical space with both `height` and `min-height` from the selected size profile.
  - Embedded iframe/wrapper nodes inside the container must be forced to fill it:
    - `position: absolute; inset: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; border: 0;`
  - Apply fill styles even when Plaid iframe is already mounted in-place (not only when reparenting nodes).

## UX Guardrail: Pre-Link Messaging + Embedded Must Be Combined

For Embedded Link, do not split the flow into separate "pre-link explainer" and "embedded launch" steps.
The active launch step must include, together:
- embedded container (`plaid-embedded-link-container`)
- concise pre-link trust messaging (security + ease + what happens next)

Required trust messaging themes in the same launch step:
- **Security**: encrypted, secure connection, credentials protection
- **Ease**: instant/fast, no manual entry, simple continuation
- **Actionability**: clear next action tied to the embedded widget in-view

## Use-Case Sizing Matrix (Hard Guidance)

Choose size profile from use case:

- **Small** (`ecommerce-checkout`)
  - target container: ~`440x200`
  - expected institutions visible: `3-4` (aim `3`)
  - rationale: minimal UI footprint, low cognitive overhead during checkout

- **Medium** (`bill-pay`)
  - target container: ~`400x270`
  - expected institutions visible: `4-6` (aim `5`)
  - rationale: enough choice density without overcrowding the bill-pay context

- **Large** (`account-funding-inbound-payments`)
  - target container: ~`700x350`
  - expected institutions visible: `6-9` (aim `7`)
  - rationale: high discovery and institution breadth for inbound funding setup

## Runtime Metadata Contract (Required for QA)

Expose these globals in embedded mode:
- `window.__embeddedLinkUseCase`
- `window.__embeddedLinkSizeProfile` (`small|medium|large`)
- `window.__embeddedLinkLayout` (`small|medium|large`)
- `window.__embeddedLinkExpectedInstitutionTilesMin`
- `window.__embeddedLinkExpectedInstitutionTilesMax`
- `window.__embeddedLinkExpectedInstitutionTileCount`

Mirror the same values on the container dataset:
- `data-plaid-embedded-use-case`
- `data-plaid-embedded-size-profile`
- `data-expected-institution-tiles-min`
- `data-expected-institution-tiles-max`
- `data-expected-institution-tiles`

## QA Requirements (Hard Gate)

Plaid Link QA must pass only when embedded mode has:
- `/api/create-link-token` HTTP 200
- response includes non-empty `link_token`
- in-page embedded widget load signal observed (`__embeddedLinkWidgetLoaded` or embedded instance object)
- no hosted redirect behavior required
- launch step includes both pre-link messaging and embedded container in the same active step
- embedded container dimensions + expected tile range aligned to selected profile (`small|medium|large`)

For embedded mode, launch success should rely on in-page widget signals, not hosted URL open attempts.
