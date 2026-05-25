#!/usr/bin/env bash
# Standalone Plaid HTML deck exporter (Bash wrapper).
# See scripts/scratch/utils/export-plaid-deck.js for full options.
#
# Usage:
#   ./scripts/export-plaid-deck.sh --manifest decks/my-deck.json --out dist/my-deck.html
#   ./scripts/export-plaid-deck.sh --manifest decks/pitch.json --out dist/pitch.html --canvas authoring --nav keyboard

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec node "$REPO_ROOT/scripts/scratch/utils/export-plaid-deck.js" "$@"
