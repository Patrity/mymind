#!/usr/bin/env bash
# Every plain runtimeConfig key the env file sets has its NUXT_ twin(s) set too (cycle 86 final wave M5).
# The pairs come from runtime-env-twins.txt, which a test derives from core's config-env mapper and
# nuxt.config — not a hand-kept list. Prints key NAMES only, never a value.
#
# Usage: check-env-twins.sh <env file> [twins file]   (exit 1: a twin is missing)
set -euo pipefail
ENV_FILE="${1:?usage: $0 <env file> [twins file]}"
TWINS="${2:-$(cd "$(dirname "$0")" && pwd)/runtime-env-twins.txt}"
[ -r "$TWINS" ] || { echo "[FAIL] $TWINS missing"; exit 1; }
set_keys="$(grep -oE '^(export +)?[A-Za-z_][A-Za-z0-9_]*=.' "$ENV_FILE" | sed -E 's/^export +//; s/=.$//' | sort -u || true)"
has() { printf '%s\n' "$set_keys" | grep -qx "$1"; }
missing=0
while read -r plain twin; do
  case "$plain" in ''|'#'*) continue ;; esac
  if has "$plain" && ! has "$twin"; then echo "[FAIL] env file sets $plain but not $twin"; missing=$((missing + 1)); fi
done < "$TWINS"
if [ "$missing" -eq 0 ]; then echo "[ok]   every runtimeConfig key set has its NUXT_ twin"; exit 0; fi
exit 1
