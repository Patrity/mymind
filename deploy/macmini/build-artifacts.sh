#!/usr/bin/env bash
# Build box (LXC 114, /opt/mymind-build, root) half of a macmini deploy (cycle 86): build the web and
# the worker, and lay out the two release trees CD streams to the mini (release.sh stage reads them as tar):
#
#   .macmini-out/web/      .output/   (Nitro's self-contained server + public assets)
#   .macmini-out/worker/   dist/ + node_modules/ (stage.mjs closure) + evals/ + release.env
#
# The mini is darwin/arm64, this box linux/x64: pnpm-workspace.yaml's supportedArchitectures makes
# `pnpm install` fetch the darwin-arm64 native packages too (sharp, @napi-rs/canvas) — but pnpm skips
# an install it believes is current, so a node_modules from before that setting is wiped first.
#
# It runs in its OWN checkout (/opt/mymind-build, synced by CD), never in /opt/mymind: that tree holds
# the retired LXC runtime — .output (mymind.service) and .worker (mymind-worker.service) — which is the
# 7-day rollback target, and must keep the pre-cutover build. The build dir has no .env, so nothing of
# LXC 114's env is baked into the mini's bundle (the mini's env file supplies every NUXT_ twin).
#
# Usage: MYMIND_GIT_SHA=<sha> bash deploy/macmini/build-artifacts.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
LXC_RUNTIME_DIR="${MYMIND_LXC_RUNTIME_DIR:-/opt/mymind}"
if [ -d "$LXC_RUNTIME_DIR" ] && [ "$APP_DIR" = "$(cd "$LXC_RUNTIME_DIR" && pwd -P)" ]; then
  echo "[build] refusing to build in $LXC_RUNTIME_DIR: it is the LXC runtime (rollback target) — CD builds in /opt/mymind-build" >&2
  exit 1
fi
cd "$APP_DIR"
OUT="$APP_DIR/.macmini-out"

# (A glob, not `ls | grep -q`: under pipefail grep's early exit can SIGPIPE ls and read as "absent".)
has_darwin() { compgen -G 'node_modules/.pnpm/@img+sharp-darwin-arm64@*' >/dev/null; }
if [ -d node_modules/.pnpm ] && ! has_darwin; then
  echo "[build] node_modules predates the darwin-arm64 binaries — clean install"
  rm -rf node_modules apps/*/node_modules packages/*/node_modules
fi
pnpm install --frozen-lockfile
has_darwin || { echo "[build] pnpm did not install @img/sharp-darwin-arm64 — check supportedArchitectures" >&2; exit 1; }

# --max-old-space-size: the nuxt/vite build needs > 2 GB of heap (V8's default OOMs it here).
NODE_OPTIONS=--max-old-space-size=4096 NUXT_PUBLIC_UNMUTE_URL="" pnpm build
pnpm --filter worker build

rm -rf "$OUT"
mkdir -p "$OUT/web"
cp -a .output "$OUT/web/.output"
# stage.mjs proves every external loads (with THIS box's binaries; release.sh stage re-proves it on
# the mini with the darwin ones).
node apps/worker/stage.mjs "$OUT/worker"
cp -a evals "$OUT/worker/evals"
# pnpm's supportedArchitectures is a cross product (os × cpu): drop the platforms nobody runs, and
# prove this box's linux-x64 and the mini's darwin-arm64 binaries both survived.
bash "$APP_DIR/deploy/macmini/prune-arch.sh" "$OUT/web" "$OUT/worker"
if [ -n "${MYMIND_GIT_SHA:-}" ]; then
  for k in web worker; do printf 'MYMIND_GIT_SHA=%s\n' "$MYMIND_GIT_SHA" > "$OUT/$k/release.env"; done
fi
du -sh "$OUT/web" "$OUT/worker"
