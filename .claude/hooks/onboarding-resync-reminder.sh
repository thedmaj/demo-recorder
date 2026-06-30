#!/usr/bin/env bash
# PostToolUse hook (Write|Edit): when an onboarding doc changes, remind the
# agent to re-publish the shared onboarding guide so the ShareOnboardingGuide
# artifact (the link teammates open) stays in sync with the repo file.
# The publish itself is an agent tool (ShareOnboardingGuide), not a shell
# command, so this hook only injects a reminder via additionalContext.
f=$(jq -r '.tool_input.file_path // ""' 2>/dev/null)
b=$(basename "$f" 2>/dev/null)
if [ "$b" = "ONBOARDING.md" ] || [ "$b" = "ONBOARDING-bootstrap.txt" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Onboarding doc changed (%s). Before ending this turn, re-publish the shared onboarding guide by calling the ShareOnboardingGuide tool (mode check) so the shared link stays in sync with the repo file."}}' "$b"
fi
