#!/usr/bin/env bash
# Build the sandbox image (cycle 82, spec §2/§9). Tags mymind-sandbox:<tag> and mymind-sandbox:current;
# the worker runs SANDBOX_IMAGE (default mymind-sandbox:current) and its boot reconcile removes
# containers built from an older image (the workspace dirs are kept).
#   usage: deploy/sandbox/build-image.sh            (prints "[sandbox] built mymind-sandbox:<tag> …")
#
# Final review I5:
#   - the tag is a CONTENT HASH of deploy/sandbox/ (CD ships the tree without .git, so a git sha
#     here would be the box's stale checkout): same files → same tag;
#   - after a successful build, old mymind-sandbox:* tags are removed — except `current`, the image
#     `current` pointed to before this build (re-tagged `previous`: the rollback) and any image a
#     container (running or stopped) uses — plus dangling sandbox images. No other image on the box
#     (db, searxng) is touched: those prunes filter on our repo / label. BuildKit cache older than
#     24h goes too (all of it — it is only a cache; the box hit 100% disk on stale cache before).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO=mymind-sandbox

hash_dir() { # sha256 over every file's path + content, in a stable order
  (cd "$DIR" && find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s\0' "$f"
    cat "$f"
  done) | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-12
}
TAG="$(hash_dir)"

PREV_ID="$(docker image inspect --format '{{.Id}}' "$REPO:current" 2>/dev/null || true)"
# --pull: re-resolve the (digest-pinned) bases every build, so a cache never hides a changed pin.
docker build --pull -t "$REPO:$TAG" -t "$REPO:current" "$DIR"
NEW_ID="$(docker image inspect --format '{{.Id}}' "$REPO:current")"
# Keep the previous image tagged (else a rebuild under the same tag would leave it dangling).
if [ -n "$PREV_ID" ] && [ "$PREV_ID" != "$NEW_ID" ]; then docker tag "$PREV_ID" "$REPO:previous"; fi

# Images any container uses — never removed.
USED=""
CIDS="$(docker ps -aq --no-trunc || true)"
if [ -n "$CIDS" ]; then
  # shellcheck disable=SC2086
  USED="$(docker inspect --format '{{.Image}}' $CIDS 2>/dev/null || true)"
fi
docker image ls "$REPO" --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | while read -r ref id; do
  case "$ref" in *:current|*:previous|*:'<none>') continue ;; esac
  if [ "$id" = "$NEW_ID" ] || [ "$id" = "$PREV_ID" ]; then continue; fi
  if printf '%s\n' "$USED" | grep -qxF -- "$id"; then continue; fi
  if docker rmi "$ref" >/dev/null 2>&1; then echo "[sandbox] pruned $ref"; fi
done
# A tag that moved leaves its old image dangling (no tag); `image prune` skips images in use.
docker image prune -f --filter "label=mymind.sandbox=image" >/dev/null || true
docker builder prune -f --filter until=24h >/dev/null || true

docker image inspect "$REPO:current" --format "[sandbox] built $REPO:$TAG ({{.Size}} bytes)"
