# Plaid Embedded Link Skill

Use this skill when the prompt asks for **Embedded Link** or **Hosted Link** behavior instead of the default in-page Plaid modal flow.

## Detection Signals

Treat Link mode as embedded when prompt/demo context includes phrases like:
- "embedded Link"
- "hosted Link"
- "Embedded Link for embedded clients"
- "Pay by Bank embedded Link"

If not explicitly requested, default to standard Plaid modal Link.

## Key Difference vs Standard Plaid Modal

- Standard modal flow:
  - Client initializes `Plaid.create({ token, onSuccess, onEvent, onExit })`
  - Calls `handler.open()`
  - Success is handled in client callback.

- Embedded/Hosted flow:
  - Server `/link/token/create` request includes a `hosted_link` object.
  - Response includes both `link_token` and `hosted_link_url`.
  - Client opens `hosted_link_url` (new tab/window/redirect), not the in-page Plaid iframe modal.
  - Success handoff is backend-driven with follow-up token/session checks.

## Build Requirements

- Keep launch CTA `data-testid="link-external-account-btn"` for pipeline contract.
- On CTA click in embedded mode:
  1. POST `/api/create-link-token`
  2. Require `link_token` and `hosted_link_url` in response
  3. Open hosted URL with `window.open(url, '_blank', 'noopener,noreferrer')`
- Log/throw clear errors when hosted URL is missing or popup is blocked.

## QA Requirements

Plaid Link QA must pass only when:
- `/api/create-link-token` returns HTTP 200
- response has non-empty `link_token`
- embedded mode additionally has non-empty `hosted_link_url`
- app attempts to open the hosted URL after launch click

Do not mark launch success using modal-only signals (`_plaidHandler` or Plaid iframe) in embedded mode.
