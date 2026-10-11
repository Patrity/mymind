#!/usr/bin/env bash
# Build the sandbox image (cycle 82, spec §2/§9). Tags mymind-sandbox:<tag> and mymind-sandbox:current;
# the worker runs SANDBOX_IMAGE (default mymind-sandbox:current) and its boot reconcile removes
# containers built from an older image (the workspace dirs are kept).
#   usage: deploy/sandbox/build-image.sh [tag]     (tag defaults to the git short sha, else "dev")
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:-$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || true)}"
TAG="${TAG:-dev}"
# --pull: re-resolve the (digest-pinned) bases every build, so a cache never hides a changed pin.
docker build --pull -t "mymind-sandbox:${TAG}" -t mymind-sandbox:current "$DIR"
docker image inspect mymind-sandbox:current --format '[sandbox] built mymind-sandbox:'"${TAG}"' ({{.Size}} bytes)'
