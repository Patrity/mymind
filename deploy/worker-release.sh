#!/usr/bin/env bash
# Agent worker release dirs (cycle 81, Task 2 review I1). Run from /opt/mymind as root (CD does).
#
#   stage     build the bundle and stage a self-contained release into .worker-next/
#             (bundle + its external packages' full dependency closure; apps/worker/stage.mjs
#             proves every external loads from there, or this fails and the deploy stops)
#   activate  swap .worker-next/ → .worker/ (previous kept as .worker-prev/ for rollback)
#   rollback  swap .worker-prev/ back to .worker/
#
# .worker/ and .worker-prev/ are preserved by CD's sync (deploy.yml), and nothing in them is touched
# by `pnpm install` / the build, so the RUNNING worker (ExecStart=/opt/mymind/.worker/dist/worker.mjs)
# keeps a complete tree — lazy imports and crash-restarts included — until `activate` runs right
# before `systemctl restart mymind-worker`.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

case "${1:-}" in
  stage)
    pnpm --filter worker build
    node apps/worker/stage.mjs "$APP_DIR/.worker-next"
    ;;
  activate)
    [ -f .worker-next/dist/worker.mjs ] || { echo "[worker-release] no staged release (.worker-next) — run stage first" >&2; exit 1; }
    rm -rf .worker-prev
    if [ -d .worker ]; then mv .worker .worker-prev; fi
    mv .worker-next .worker
    echo "[worker-release] activated .worker (previous: $( [ -d .worker-prev ] && echo .worker-prev || echo none ))"
    ;;
  rollback)
    [ -f .worker-prev/dist/worker.mjs ] || { echo "[worker-release] no previous release to roll back to" >&2; exit 1; }
    rm -rf .worker-next
    mv .worker .worker-next
    mv .worker-prev .worker
    echo "[worker-release] rolled back (.worker-next holds the release that was active)"
    ;;
  *)
    echo "usage: $0 stage|activate|rollback" >&2; exit 2 ;;
esac
