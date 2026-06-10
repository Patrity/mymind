---
title: CI + Deploy Pipeline (self-hosted Proxmox runner)
cycle: infra
date: 2026-06-09
status: implemented-pending-runner
spec: ../superpowers/specs/2026-06-09-ci-deploy-pipeline-design.md
plan: ../superpowers/plans/2026-06-09-ci-deploy-pipeline.md
wiki: ../wiki/ci-deploy-pipeline.md
shipped:
  - ".github/workflows/deploy.yml — single workflow, on: push. Job `test` (ubuntu-latest, every push): pnpm install --frozen-lockfile, lint (continue-on-error — repo is lint-red, 215 errors), typecheck, test, build (NUXT_PUBLIC_UNMUTE_URL=\"\"). Job `deploy` (runs-on [self-hosted, proxmox], needs: test, if ref==master, timeout-minutes: 20): tar-pipe checkout into LXC 114 /opt/mymind (excludes .git/node_modules/.nuxt/.output/.data/.env), docker compose -f docker-compose.prod.yml up -d --build (Dockerfile auto-runs db:migrate on start), /login health check (30×5s, fail if never 200). concurrency group deploy-${{ github.ref }}, cancel-in-progress on master."
  - ".github/actionlint.yaml — registers the self-hosted `proxmox` label so actionlint passes clean."
  - "Removed .github/workflows/ci.yml (lint+typecheck only) — folded into the new test job."
  - "docs/DEPLOYMENT.md §15 — pipeline description + one-time self-hosted runner registration steps for host `mini`."
  - "docs/wiki/ci-deploy-pipeline.md — living how-it-works page."
verified:
  - "Locally on master's tree: typecheck PASS, test PASS (158 tests / 31 files, ~1.3s), build PASS (.output produced), lint RED (expected, non-blocking)."
  - "actionlint (rhysd/actionlint Docker image) exits 0 on deploy.yml."
  - "Homelab facts confirmed via ssh mini: Proxmox pve 9 (pct, no LXD), LXC 114 = mymind @ 192.168.2.89, mymind-app + mymind-db up, repo at /opt/mymind (copied tree, NO .git), .env present (uid 501)."
deferred:
  - "Task 4 (end-to-end deploy) is BLOCKED until the operator registers a self-hosted GitHub Actions runner on `mini` with label `proxmox` — see DEPLOYMENT §15. Until then the `deploy` job has no runner and will queue."
  - "tar-extract is not deletion-safe: files removed from the repo are not removed from /opt/mymind. Switch to git-reset-in-container or rsync --delete if it ever bites."
  - "Lint stays non-blocking until the repo's 215 lint errors are brought to green (separate task)."
  - "build env NUXT_PUBLIC_UNMUTE_URL=\"\" matches the current Dockerfile ARG default; once voice v2 fully lands and drops that var (cycle 18 handover notes its removal), this line can go too. Harmless meanwhile (unused env)."
notes:
  - "Branch feat/ci-deploy-pipeline also contains unrelated voice-visualizer commits (52d25b9, 50a72eb) and a .gitignore change that a concurrent session committed onto the same branch — NOT part of this work. Decide how to separate before merging the CI work."
---

# CI + Deploy Pipeline — Handover

## What this is
Replaces the lint+typecheck-only `ci.yml` with a test-every-push + continuous-deploy-master
pipeline. Tests run on GitHub-hosted runners; the deploy runs on a self-hosted runner **on
the Proxmox host `mini`** (required — the app LXC is on the LAN and unreachable from
GitHub-hosted infra) and rebuilds the app **inside LXC 114** via `pct exec`.

## The one seam left open
**Register the runner.** The deploy job targets `runs-on: [self-hosted, proxmox]`. No such
runner exists yet. Follow `docs/DEPLOYMENT.md §15` on `mini` (as a user that can run `pct`).
Once it shows **Idle** in GitHub → Settings → Actions → Runners, push to `master` triggers
the first real deploy. Verify per plan Task 4: deploy job green + final step prints
`healthy`; then `ssh mini` to confirm `mymind-app` restarted and `/login` returns 200.

## Why these choices
- **tar-pipe (not git pull in container):** /opt/mymind has no `.git`, and the repo is
  private — tar-pipe needs no GitHub credential inside the container and preserves `.env`.
- **lint non-blocking:** the repo is lint-red (215 errors); a hard lint gate would block
  every deploy. Visible annotations without blocking is the pragmatic gate this cycle.
- **migrations:** no explicit migrate step — the Dockerfile CMD runs `pnpm db:migrate` on
  container start, so `up -d --build` migrates automatically.
