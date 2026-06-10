---
title: CI/CD Deploy Pipeline
status: shipped
updated: 2026-06-09
---

# CI/CD Deploy Pipeline

How code reaches the homelab **today**.

## Trigger
`.github/workflows/deploy.yml`, `on: push` (all branches).

## Job: test (GitHub-hosted `ubuntu-latest`, every push)
`pnpm install --frozen-lockfile` → lint (non-blocking) → typecheck → test → build
(`NUXT_PUBLIC_UNMUTE_URL=""`). Typecheck, test, and build are hard gates; lint only
annotates because the repo is lint-red.

## Job: deploy (self-hosted `proxmox` runner on `mini`, `master` only)
`needs: test`, `if: github.ref == 'refs/heads/master'`. Steps:
1. `actions/checkout` on the host.
2. `tar … | pct exec 114 -- tar -x` the tree into `/opt/mymind` (excludes `.git`,
   `node_modules`, `.nuxt`, `.output`, `.data`, `.env`).
3. `pct exec 114 -- … docker compose -f docker-compose.prod.yml up -d --build`
   (rebuilds the image; `pnpm db:migrate` runs on container start).
4. Health check: `/login` must return 200 (30 × 5s) or the job fails.

`concurrency: deploy-${{ github.ref }}` with `cancel-in-progress` on master — a newer
push supersedes an in-flight deploy.

## Target
- Host: `mini` (Proxmox, 192.168.2.50) — runs the self-hosted runner.
- App: LXC **114** (`mymind`, 192.168.2.89) — runs `mymind-app` + `mymind-db` via compose.
- Deploy dir: `/opt/mymind` (copied tree, not a git checkout). `.env` and volumes persist.

## Runner setup
One-time manual registration — see `docs/DEPLOYMENT.md` §15.

## Known limitations
- tar-extract does not delete files removed from the repo (stale files cleaned by hand).
- Lint is non-blocking until the repo is brought to green.
- Single app instance (scheduled tasks are not distributed-locked — see DEPLOYMENT §7).
