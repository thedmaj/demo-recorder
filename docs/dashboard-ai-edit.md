# Dashboard AI Edit Configuration

This document describes runtime controls for the Dashboard AI Edit overlay and backend route.

## Environment Variables

### Model routing by mode

- `DASHBOARD_AI_EDIT_MODEL_CSS` (default: `claude-haiku-4-5-20251001`)
- `DASHBOARD_AI_EDIT_MODEL_ELEMENT_CSS` (default: `claude-haiku-4-5-20251001`)
- `DASHBOARD_AI_EDIT_MODEL_ELEMENT` (default: `claude-haiku-4-5-20251001`)
- `DASHBOARD_AI_EDIT_MODEL_STEP` (default: `claude-haiku-4-5-20251001`)
- `DASHBOARD_AI_EDIT_MODEL_FULL` (default: `claude-opus-4-7`)

### Output token budgets by mode

- `DASHBOARD_AI_EDIT_MAX_TOKENS_CSS` (default: `4000`)
- `DASHBOARD_AI_EDIT_MAX_TOKENS_ELEMENT_CSS` (default: `6000`)
- `DASHBOARD_AI_EDIT_MAX_TOKENS_ELEMENT` (default: `4000`)
- `DASHBOARD_AI_EDIT_MAX_TOKENS_STEP` (default: `8000`)
- `DASHBOARD_AI_EDIT_MAX_TOKENS_FULL` (default: `20000`)

Backward compatibility:

- `DASHBOARD_AI_EDIT_FULL_MAX_TOKENS` is still honored as an alias fallback for full mode.

### Context and history limits

- `DASHBOARD_AI_EDIT_PICKED_HTML_MAX_CHARS` (default: `2000`)  
  Max selected element/context payload size captured by overlay.
- `DASHBOARD_AI_EDIT_SELECTED_HTML_MAX_CHARS` (default: `1200`)  
  Server-side prompt snippet clamp for selected HTML.
- `DASHBOARD_AI_EDIT_CONVERSATION_MAX_TURNS` (default: `12`)
- `DASHBOARD_AI_EDIT_CONVERSATION_MAX_CHARS_PER_TURN` (default: `2000`)
- `DASHBOARD_AI_EDIT_CONVERSATION_MAX_TOTAL_CHARS` (default: `12000`)

### Optional multi-pass mode

- `DASHBOARD_AI_EDIT_ENABLE_MULTI_PASS` (default: `false`)
- `DASHBOARD_AI_EDIT_MULTI_PASS_MODEL` (default: `claude-haiku-4-5-20251001`)
- `DASHBOARD_AI_EDIT_MULTI_PASS_MAX_TOKENS` (default: `2000`)

When enabled (for `element`, `step`, `full`), the server runs:
1. planning pass,
2. apply pass,
3. local structural validation pass.

## Suggested Presets

### Fast

```bash
DASHBOARD_AI_EDIT_MODEL_FULL=claude-haiku-4-5-20251001
DASHBOARD_AI_EDIT_MAX_TOKENS_FULL=9000
DASHBOARD_AI_EDIT_ENABLE_MULTI_PASS=false
```

### Balanced

```bash
DASHBOARD_AI_EDIT_MODEL_FULL=claude-opus-4-7
DASHBOARD_AI_EDIT_MAX_TOKENS_FULL=20000
DASHBOARD_AI_EDIT_CONVERSATION_MAX_TOTAL_CHARS=16000
DASHBOARD_AI_EDIT_ENABLE_MULTI_PASS=false
```

### High-fidelity

```bash
DASHBOARD_AI_EDIT_MODEL_FULL=claude-opus-4-7
DASHBOARD_AI_EDIT_MAX_TOKENS_FULL=28000
DASHBOARD_AI_EDIT_CONVERSATION_MAX_TOTAL_CHARS=24000
DASHBOARD_AI_EDIT_ENABLE_MULTI_PASS=true
DASHBOARD_AI_EDIT_MULTI_PASS_MAX_TOKENS=3000
```

## Troubleshooting

- **`Response was truncated (hit max_tokens=...)`**
  - Increase mode-specific max tokens for the active mode.
  - Prefer step/element pick mode over full-file mode to reduce prompt size.
- **`AI response could not be applied cleanly`**
  - Re-pick the element to refresh selector/context payload.
  - Use a more specific selector (`id` or `data-testid`).
- **`AI edit validation failed`**
  - The generated output removed required app contracts (`data-testid`, `goToStep`, or step shell shape).  
    Retry with narrower edit scope.
