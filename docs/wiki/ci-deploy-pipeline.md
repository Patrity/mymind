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
2. **Delete-aware sync** into `/opt/mymind`: first clear the tracked tree on the box
   (`find -maxdepth 1` removing everything except the preserved runtime entries
   `.git`/`.env`/`.data`/`.output`/`.nuxt`/`node_modules`), then `tar … | pct exec 114 -- tar -x`
   the fresh checkout (same exclude set). The clear step is what makes deletions propagate —
   a plain `tar -x` overwrites but never removes, so a file deleted in the repo would otherwise
   linger and break the build (it did once: a deleted `image-ocr.ts` still importing a removed
   `describeImage` export failed `pnpm build`, cycle 20).
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
- Deletions now propagate (the sync clears the tracked tree before extracting, preserving
  runtime state); only `.env` + the Docker named volumes (`mymind-pgdata`, `mymind-uploads`)
  survive a sync — anything else under `/opt/mymind` not in the repo is wiped on each deploy.
- Lint is non-blocking until the repo is brought to green.
- Single app instance (scheduled tasks are not distributed-locked — see DEPLOYMENT §7).
