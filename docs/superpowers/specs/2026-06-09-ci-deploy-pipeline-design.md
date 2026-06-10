---
title: CI + Deploy Pipeline (self-hosted Proxmox runner)
status: spec
created: 2026-06-09
topic: ci-deploy-pipeline
---

# CI + Deploy Pipeline — Design

## Goal

Replace the current lint+typecheck-only CI with a single GitHub Actions workflow that
**tests every push** and **continuously deploys `master`** to the homelab by rebuilding
the app inside Proxmox LXC **114** (`mymind`, `192.168.2.89`).

Continuous deployment, single-user repo: push to `master` → tests gate → deploy.

## Constraints / discovered facts

- **Deploy target is on the LAN.** The app LXC must reach the AI rig (`192.168.2.25`),
  so GitHub-hosted runners cannot touch it. Deploy must run on a **self-hosted runner on
  the Proxmox host** (`mini`, `192.168.2.50`).
- **Host is Proxmox (pve-manager 9), no LXD.** The container exec command is
  **`pct exec 114 -- …`** (not `lxc exec`). `lxc-attach` also exists but `pct` is canonical.
- **App LXC 114** runs `docker compose` (`mymind-app`, `mymind-db`) and builds the image
  **in place** (`up -d --build`); `rebuild.log` confirms the current manual pattern.
- **Repo on the box lives at `/opt/mymind`** and is a **copied tree, not a git checkout**
  (no `.git`). `.env` lives there (uid 501, rsync'd from the Mac) and **must be preserved**.
- **Dockerfile already runs `pnpm db:migrate` on container start** → migrations are
  automatic after a rebuild; no separate migrate step in the workflow.
- **Tests are pure unit tests** (vitest, 158 tests, ~1.3s, no DB/network). Test job needs
  no Postgres service.
- **Lint is red repo-wide** (215 errors, 23 warnings as of 2026-06-09). It is therefore a
  **non-blocking** step (`continue-on-error`) — visible annotations, but it does not block
  deploys. (Locked for this cycle; revisit if/when lint is brought to green.)

## Architecture

One workflow file: **`.github/workflows/deploy.yml`** (replaces `ci.yml`). Two jobs.

```
push (any branch) ──> [ test ] ──(success)──> [ deploy ]  (only if ref == master)
```

### Job 1 — `test` (GitHub-hosted `ubuntu-latest`, every push)

Runs on all branches so feature branches are gated too.

| Step | Command | Blocking |
|---|---|---|
| checkout | `actions/checkout@v6` | — |
| pnpm | `pnpm/action-setup@v6` (v11.5 via `packageManager`) | — |
| node | `actions/setup-node@v6`, node 22, `cache: pnpm` | — |
| install | `pnpm install --frozen-lockfile` | yes |
| lint | `pnpm run lint` | **no** (`continue-on-error: true`) |
| typecheck | `pnpm typecheck` | yes |
| test | `pnpm test` | yes |
| build | `pnpm build` (`NUXT_PUBLIC_UNMUTE_URL=""`) | yes |

### Job 2 — `deploy` (self-hosted `mini`, `needs: test`, `if: github.ref == 'refs/heads/master'`)

`runs-on: [self-hosted, proxmox]`. Steps:

1. **checkout** — populates the runner workspace on the host.
2. **sync code into LXC 114** (tar-pipe; preserves `.env` + data, no creds in container):
   ```bash
   tar -C "$GITHUB_WORKSPACE" \
     --exclude=.git --exclude=node_modules --exclude=.nuxt \
     --exclude=.output --exclude=.data --exclude=.env \
     -cf - . | pct exec 114 -- tar -C /opt/mymind -xf -
   ```
3. **rebuild + restart** (migrations run automatically via Dockerfile CMD):
   ```bash
   pct exec 114 -- bash -lc 'cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d --build'
   ```
4. **health check** — retry loop, fail the job if `/login` never returns 200:
   ```bash
   pct exec 114 -- bash -lc 'for i in $(seq 1 30); do
     code=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3000/login || true)
     [ "$code" = "200" ] && exit 0; sleep 5; done; exit 1'
   ```

**Concurrency:** group `deploy-master` with `cancel-in-progress: true` so a newer push
supersedes an in-flight deploy.

## Code-transfer decision (why tar-pipe)

| Approach | Deletion-safe | Creds in container | SSH host→114 | Verdict |
|---|---|---|---|---|
| **tar-pipe (chosen)** | no¹ | none | no | Simplest; exact committed tree |
| git reset --hard in 114 | yes | deploy key (private repo) | no | More setup |
| rsync host→114 over SSH | yes | none | yes | Needs SSH into 114 |

¹ tar-extract does not remove files deleted from the repo. Rare for this repo; a future
`git clean`-style step or switch to rsync/`--delete` can be added if it bites.

## One-time manual setup (operator, not in the workflow)

Register a GitHub Actions **self-hosted runner on `mini`** with label `proxmox`, running
as a user that can invoke `pct` (root, or a sudoers entry for `pct`). `tar` and `curl` are
already present on the host. Document the exact steps in `docs/DEPLOYMENT.md` (new section)
and the wiki.

## Out of scope

- Fixing the 215 lint errors (lint stays non-blocking this cycle).
- Building/pushing an image to GHCR (build stays in-container).
- Zero-downtime / blue-green deploy (single instance by design — see DEPLOYMENT §7).
- Deletion-safe sync (`--delete`) — deferred unless a stale-file bug appears.

## Success criteria

1. Push to a feature branch → `test` job runs (lint annotates, typecheck/test/build gate).
2. Push to `master` with green tests → `deploy` job rebuilds LXC 114 and the health check
   passes (`/login` → 200).
3. `.env` and persistent volumes in LXC 114 are untouched across a deploy.
4. A failing typecheck/test/build on `master` blocks the deploy.

## Docs to update on ship

- `docs/DEPLOYMENT.md` — add a "CI/CD" section (runner registration + how deploy works).
- `docs/wiki/` — new page for the deploy pipeline (current behaviour).
- `docs/handovers/` — handover for this cycle.
