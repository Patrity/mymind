---
title: CI + Deploy Pipeline (self-hosted Proxmox runner)
cycle: infra
date: 2026-06-09
status: shipped
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
  - "LIVE END-TO-END (run 27266499739, master sha faa398d): test job green; deploy job green on the mini-proxmox self-hosted runner (Sync→Rebuild→Health all success). Verified on box: mymind-app rebuilt (Up <1m), /login=200, mymind-db untouched, /opt/mymind/.env preserved."
  - "Runner mini-proxmox registered as a systemd service on host mini (RUNNER_ALLOW_RUNASROOT=1 so it can call pct); labels [self-hosted, Linux, X64, proxmox]; service path includes /usr/sbin so bare `pct` resolves."
deferred:
  - "tar-extract is not deletion-safe: files removed from the repo are not removed from /opt/mymind. Switch to git-reset-in-container or rsync --delete if it ever bites."
  - "Lint stays non-blocking until the repo's 215 lint errors are brought to green (separate task)."
  - "build env NUXT_PUBLIC_UNMUTE_URL=\"\" matches the current Dockerfile ARG default; once voice v2 fully lands and drops that var (cycle 18 handover notes its removal), this line can go too. Harmless meanwhile (unused env)."
  - "Docs-only pushes (docs/** and **.md) are excluded via on.push.paths-ignore, so editing handovers/wiki/specs does not trigger a rebuild+deploy."
notes:
  - "The CI work was landed via a clean cherry-pick onto master (PR #1, rebase-merged). Unrelated voice-visualizer doc commits that had been interleaved on the working branch were cherry-picked to master separately; the working branch was then deleted."
---

# CI + Deploy Pipeline — Handover

## What this is
Replaces the lint+typecheck-only `ci.yml` with a test-every-push + continuous-deploy-master
pipeline. Tests run on GitHub-hosted runners; the deploy runs on a self-hosted runner **on
the Proxmox host `mini`** (required — the app LXC is on the LAN and unreachable from
GitHub-hosted infra) and rebuilds the app **inside LXC 114** via `pct exec`.

## Status: live
The runner is registered on `mini` (systemd service) and the first end-to-end deploy ran
green — see the `verified` frontmatter. Every push to `master` that touches non-docs files
now runs `test` then, on success, `deploy` (rebuild LXC 114 + `/login` health check).

If the runner ever needs re-registering: `docs/DEPLOYMENT.md §15`. To roll the deploy back,
deploy a previous master commit (the deploy is idempotent — it rebuilds whatever is at HEAD).

## Why these choices
- **tar-pipe (not git pull in container):** /opt/mymind has no `.git`, and the repo is
  private — tar-pipe needs no GitHub credential inside the container and preserves `.env`.
- **lint non-blocking:** the repo is lint-red (215 errors); a hard lint gate would block
  every deploy. Visible annotations without blocking is the pragmatic gate this cycle.
- **migrations:** no explicit migrate step — the Dockerfile CMD runs `pnpm db:migrate` on
  container start, so `up -d --build` migrates automatically.
