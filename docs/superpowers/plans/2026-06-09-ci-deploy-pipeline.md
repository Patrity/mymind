# CI + Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lint+typecheck-only CI with one workflow that tests every push and continuously deploys `master` to the homelab by rebuilding the app inside Proxmox LXC 114 via `pct exec`.

**Architecture:** Two-job GitHub Actions workflow. Job `test` runs on GitHub-hosted `ubuntu-latest` for every push (lint non-blocking; typecheck/test/build gate). Job `deploy` runs on a self-hosted runner on the Proxmox host (`mini`), only for `master`, and tar-pipes the checked-out tree into LXC 114, then `docker compose up -d --build` (migrations auto-run via the Dockerfile CMD) and a `/login` health check.

**Tech Stack:** GitHub Actions, pnpm 11.5, Node 22, Proxmox `pct`, Docker Compose, vitest, actionlint (validation).

Spec: `docs/superpowers/specs/2026-06-09-ci-deploy-pipeline-design.md`

---

## File Structure

- **Create:** `.github/workflows/deploy.yml` — the entire pipeline (test + deploy jobs).
- **Delete:** `.github/workflows/ci.yml` — superseded (its lint/typecheck steps fold into the `test` job).
- **Modify:** `docs/DEPLOYMENT.md` — add a "15. CI/CD pipeline" section (runner registration + how deploy works).
- **Create:** `docs/wiki/ci-deploy-pipeline.md` — living "how the pipeline works today" page.

---

## Task 1: Author and validate the workflow

**Files:**
- Create: `.github/workflows/deploy.yml`
- Delete: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/deploy.yml`**

```yaml
name: deploy

on: push

# A newer push to master supersedes an in-flight deploy.
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: ${{ github.ref == 'refs/heads/master' }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Install pnpm
        uses: pnpm/action-setup@v6

      - name: Install node
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Lint is red repo-wide (215 errors as of 2026-06-09): annotate, do not block.
      - name: Lint
        continue-on-error: true
        run: pnpm run lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test

      - name: Build
        run: pnpm build
        env:
          NUXT_PUBLIC_UNMUTE_URL: ""

  deploy:
    needs: test
    if: github.ref == 'refs/heads/master'
    runs-on: [self-hosted, proxmox]
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Sync code into LXC 114
        run: |
          tar -C "$GITHUB_WORKSPACE" \
            --exclude=.git --exclude=node_modules --exclude=.nuxt \
            --exclude=.output --exclude=.data --exclude=.env \
            -cf - . | pct exec 114 -- tar -C /opt/mymind -xf -

      - name: Rebuild + restart (migrations run on container start)
        run: |
          pct exec 114 -- bash -lc 'cd /opt/mymind && docker compose -f docker-compose.prod.yml up -d --build'

      - name: Health check (/login -> 200)
        run: |
          pct exec 114 -- bash -lc 'for i in $(seq 1 30); do
            code=$(curl -fsS -o /dev/null -w "%{http_code}" http://localhost:3000/login || true)
            if [ "$code" = "200" ]; then echo "healthy"; exit 0; fi
            echo "waiting ($i): got $code"; sleep 5
          done; echo "never became healthy"; exit 1'
```

- [ ] **Step 2: Delete the old workflow**

```bash
git rm .github/workflows/ci.yml
```

- [ ] **Step 3: Validate workflow syntax with actionlint**

Run (no install needed — uses the official Docker image):
```bash
docker run --rm -v "$(pwd):/repo" --workdir /repo rhysd/actionlint:latest -color
```
Fallback if Docker is unavailable: `brew install actionlint && actionlint`.

Expected: exits 0 with no errors for `.github/workflows/deploy.yml`. (actionlint also runs `shellcheck` on the `run:` blocks — fix any quoting warnings it reports.)

- [ ] **Step 4: Prove the `test` job's gates pass locally**

These are the exact commands the `test` job runs. Run them from the repo root:
```bash
pnpm install --frozen-lockfile
pnpm typecheck   # expected: exits 0
pnpm test        # expected: "Tests  158 passed" (or current count), exits 0
NUXT_PUBLIC_UNMUTE_URL="" pnpm build   # expected: exits 0, .output/ produced
pnpm run lint || echo "lint red (expected, non-blocking)"   # expected: exits 1, that's fine
```
Expected: typecheck/test/build exit 0; lint exits non-zero (non-blocking by design).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
ci: test-every-push + deploy-master pipeline (self-hosted Proxmox runner)

- test job (ubuntu-latest): install/lint(non-blocking)/typecheck/test/build
- deploy job (self-hosted proxmox, master only): tar-pipe into LXC 114,
  compose up --build (auto-migrate), /login health check
- replaces ci.yml

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Document runner registration + pipeline in DEPLOYMENT.md

**Files:**
- Modify: `docs/DEPLOYMENT.md` (add a new section after §14)

- [ ] **Step 1: Append the CI/CD section**

Add this section to `docs/DEPLOYMENT.md`:

````markdown
## 15. CI/CD pipeline (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push:
- **test** (GitHub-hosted): `pnpm install --frozen-lockfile`, lint (non-blocking — repo is
  red), `typecheck`, `test`, `build`. Gates the deploy.
- **deploy** (self-hosted on `mini`, `master` only): syncs the checked-out tree into LXC
  114 at `/opt/mymind` via a `tar | pct exec 114 -- tar -x` pipe (preserves `.env` and the
  Docker volumes), then `docker compose -f docker-compose.prod.yml up -d --build`. The
  Dockerfile runs `pnpm db:migrate` on start, so migrations apply automatically. A
  `/login` health check (200, 30×5s retries) must pass or the job fails.

### One-time: register the self-hosted runner on `mini`

The deploy job needs a runner **on the Proxmox host** (it must call `pct`). Run on `mini`
as a user that can invoke `pct` (root, or a sudoers `pct` entry):

```bash
# On the host `mini` (192.168.2.50):
mkdir -p /opt/actions-runner && cd /opt/actions-runner
# Get the latest runner tarball URL + a registration token from:
#   GitHub repo → Settings → Actions → Runners → New self-hosted runner (Linux x64)
curl -o actions-runner.tar.gz -L <RUNNER_TARBALL_URL>
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/<owner>/<repo> --token <REG_TOKEN> --labels proxmox --unattended
# Install + start as a service so it survives reboots:
./svc.sh install
./svc.sh start
```

Verify in GitHub → Settings → Actions → Runners: the runner shows **Idle** with label
`proxmox`. `tar` and `curl` are already on the host. The deploy job targets
`runs-on: [self-hosted, proxmox]`, so the label must match exactly.

> **Note:** `/opt/mymind` on LXC 114 is the deploy target. It is a plain copied tree (not a
> git checkout); the pipeline overwrites tracked files but leaves `.env`, `.env.bak-*`, and
> the Docker volumes alone. Files **deleted** from the repo are not removed from
> `/opt/mymind` (tar-extract limitation) — clean stale files by hand if it ever matters.
````

- [ ] **Step 2: Commit**

```bash
git add docs/DEPLOYMENT.md
git commit -m "docs(deploy): document CI/CD pipeline + self-hosted runner setup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add the wiki page

**Files:**
- Create: `docs/wiki/ci-deploy-pipeline.md`

- [ ] **Step 1: Write the wiki page**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/wiki/ci-deploy-pipeline.md
git commit -m "docs(wiki): add CI/CD deploy pipeline page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: End-to-end verification (after runner is registered)

**Prerequisite:** Task 2's runner registration is done and the runner shows **Idle** in GitHub.

- [ ] **Step 1: Push the branch and open a PR (or push a no-op to a feature branch)**

```bash
git push -u origin feat/ci-deploy-pipeline
```
Expected: the `test` job runs on GitHub-hosted infra; `deploy` is **skipped** (ref ≠ master).
Confirm in the Actions tab: test green (lint annotated but not failing), deploy skipped.

- [ ] **Step 2: Merge to master and watch the deploy**

After merge (or push to master):
- `test` job runs and goes green.
- `deploy` job picks up on the `proxmox` runner: sync → rebuild → health check.

Expected: deploy job green, final step prints `healthy`.

- [ ] **Step 3: Confirm the box actually updated**

```bash
ssh mini 'pct exec 114 -- bash -lc "docker ps --format \"{{.Names}} {{.Status}}\"; curl -s -o /dev/null -w \"login=%{http_code}\n\" http://localhost:3000/login"'
```
Expected: `mymind-app` shows a recent `Up` (just restarted), `login=200`.

- [ ] **Step 4: Confirm `.env` survived**

```bash
ssh mini 'pct exec 114 -- bash -lc "ls -la /opt/mymind/.env"'
```
Expected: `.env` still present (uid 501), untouched by the deploy.

---

## Self-Review

**Spec coverage:**
- Test job (lint non-blocking / typecheck / test / build) → Task 1 ✅
- Deploy job (tar-pipe / compose build / auto-migrate / health check) → Task 1 ✅
- Concurrency group → Task 1 ✅
- Replace `ci.yml` → Task 1 (git rm) ✅
- `pct exec 114`, `/opt/mymind`, `.env` preserved → Task 1 excludes `.env`; verified in Task 4 ✅
- Self-hosted runner one-time setup → Task 2 ✅
- DEPLOYMENT.md + wiki docs → Tasks 2 & 3 ✅
- Success criteria 1–4 → Task 4 steps 1–4 ✅

**Placeholder scan:** `<RUNNER_TARBALL_URL>`, `<REG_TOKEN>`, `<owner>/<repo>` are genuine
operator-supplied values from the GitHub runner-registration UI (cannot be hardcoded), not
plan placeholders. All code/commands are complete.

**Type consistency:** Label `proxmox` used identically in `runs-on`, DEPLOYMENT §15, and the
wiki. Path `/opt/mymind` and container id `114` consistent across all tasks. Health-check
command identical in workflow and verification.
