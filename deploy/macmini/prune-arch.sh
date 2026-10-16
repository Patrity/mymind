#!/usr/bin/env bash
# Drop the native-binary platforms nobody runs from a macmini release tree (cycle 86).
#
# pnpm's supportedArchitectures is a cross product (os x cpu): asking for linux+darwin and x64+arm64
# also installs linux-arm64 and darwin-x64 (and musl) binaries. Only two platforms ever run a release:
# LXC 114 (linux-x64, stage.mjs's load check) and the mini (darwin-arm64). Everything else is dead
# weight in the tar CD streams — and a pruning pattern that is too greedy would silently delete one
# of the two that matter, so after pruning this asserts both still carry at least one *.node binary.
#
# Usage: prune-arch.sh <dir>...   (exit 1: a dir lost its linux-x64 or darwin-arm64 binaries)
set -euo pipefail
[ "$#" -gt 0 ] || { echo "usage: $0 <dir>..." >&2; exit 2; }

rc=0
for dir in "$@"; do
  [ -d "$dir" ] || { echo "[prune-arch] $dir is not a directory" >&2; exit 2; }
  # Relative to the dir (cd + .): the dir's own name or its parents never match a pattern.
  (cd "$dir" && find . -mindepth 1 -depth -type d \( -name '*-linux-arm64*' -o -name '*-darwin-x64*' -o -name '*-linuxmusl-*' \) -exec rm -rf {} +)
  for plat in linux-x64 darwin-arm64; do
    if [ -z "$(cd "$dir" && find . -type f -name '*.node' -path "*$plat*" -print -quit)" ]; then
      echo "[prune-arch] $dir has no $plat *.node left — refusing the release" >&2
      rc=1
    fi
  done
done
exit "$rc"
