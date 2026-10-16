# Mac Mini Host Implementation Plan (cycle 86, harness step 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MyMind (web + worker) runs natively on the Mac mini as `bridget` against the central Postgres, Bridget's workspace is the real machine (full FS + LAN + internet) with switchable taint confinement via `sandbox-exec`, SearXNG is gone (Brave only), and CD builds on LXC 114 and ships to the mini.

**Architecture:** a host runtime behind the existing sandbox-manager interface; Docker runtime + firewall provisioning deleted; `deploy/macmini/` (launchd plists, provision, release); `deploy.yml` re-targeted; Brave limiter; a controller-run cutover.

**Tech Stack:** Node 22 on macOS (launchd), `sandbox-exec`, `@mymind/core`, worker, drizzle, Postgres 17 (`192.168.2.80`), GitHub Actions self-hosted runner, vitest, playwright-cli.

**Spec:** `docs/superpowers/specs/2026-10-13-macmini-host-design.md`

## Global Constraints

- **Clean runs are unrestricted**: no path containment for absolute paths, no network restriction, no concurrency cap, no per-workspace quota. Relative paths resolve inside the workspace. Keep output caps + foreground timeouts only.
- **Taint confinement** only when `agent.taintConfinement` (default `true`) AND the run is tainted: `sandbox-exec` profile denying network and file writes outside the workspace + a per-run tmp dir; no secrets; background shells/watches refused; every confinement logs `sandbox:confined` and shows a chip.
- Low-disk alarm: < 5 GB free → iMessage Tony once + pause new workspace work; resume ≥ 8 GB.
- Evals: workspace commands inside an eval world ALWAYS run confined (offline, scratch dir); host-level escape refused as today; per-world schemas on the central DB unchanged.
- DB: `DATABASE_URL` and `NUXT_DATABASE_URL` both point at `192.168.2.80:5432/bridget` (role `bridget`, not superuser; extensions pre-installed — migrations must not need `CREATE EXTENSION` privileges beyond `IF NOT EXISTS` on existing ones).
- Search: Brave only; token bucket default 1 req/s burst 3 (`search.brave.qps`), retry on 429 with backoff.
- Never touch BlueBubbles on the mini. Never bash -x anything that reads env files.
- Gates: typecheck, test, test:db, build + worker stage. Conventional commits, **no attribution trailers**. Commit first, mutate, restore with `git checkout`; never `git stash`. `expect.stringMatching`, never a bare RegExp in `toMatchObject`. Dev DB shared — own `MYMIND_BUS_NS`. Kill only your own PIDs.

## Review Focus
1. **The confinement actually confines** (darwin integration test: no network, no write outside workspace) and only when it should (clean runs untouched; the switch works).
2. **Eval isolation on the host runtime** — no eval command can reach the network/host outside its scratch dir.
3. **Deploy correctness** — launchd units restart on crash/boot, release swap + rollback, migrations against `.80`, health gates, no secrets in logs.
4. **Search regression** — every SearXNG reference gone; research fan-out within Brave limits.
5. **Process lifecycle on the host** — background shells as process groups, killed on stop/terminal/taint; no orphans after worker restart.

---

### Task 1: Host runtime + taint confinement (replaces the Docker runtime)
Files: `packages/core/src/lib/sandbox/host/*` (runtime, sandbox-exec profile builder, process-group shells, disk alarm) + tests (darwin-gated integration), manager wiring (host runtime by default; Docker runtime + `docker.ts` + network/iptables code removed), workspace tool path semantics (relative → workspace, absolute anywhere), `agent.taintConfinement` setting (agent settings doc + Settings → Bridget toggle), `sandbox:confined` activity + run event + tool-part chip, eval world: commands always confined, prompt SHELL block rewrite, removal of host `exec` + `admin` toolset (and tests), deletion of `deploy/sandbox/*`.
- [ ] Tests: clean command reaches a LAN/loopback listener and writes outside the workspace; tainted command (switch on) cannot connect (loopback listener) nor write outside the workspace/tmp, can write inside; switch off → tainted command unconfined; secrets absent when tainted; background shell refused when tainted; process-group kill leaves no child; restart re-attach/lost; disk alarm thresholds; eval world command confined regardless of the switch; relative/absolute path resolution.
- [ ] Commit `feat(workspace): native host runtime with switchable taint confinement`.

### Task 2: Brave-only search
Files: delete `search/providers/searxng.ts`; `search/{types,store,resolve}.ts`, settings routes + `SearchTab.vue` (Brave only, key status, qps setting), token-bucket limiter + 429 retry shared by `web_search`/`research_web`, wiki/web-research references, docker-compose/provision/service references to SearXNG.
- [ ] Tests: limiter (burst/rate/queue), 429 retry/backoff, resolve always Brave, settings validation; grep proves no `searxng` left outside docs history. Browser: Settings → Search.
- [ ] Commit `feat(search): Brave only, rate-limited`.

### Task 3: Mac mini deploy
Files: `deploy/macmini/{com.mymind.web.plist,com.mymind.worker.plist,provision-macmini.sh,release.sh,newsyslog.conf}`, `.github/workflows/deploy.yml` (build in LXC 114 as today; ship `.output` + worker release to `bridget@192.168.2.35` via rsync/ssh; cancel evals → migrate against `.80` → activate → `launchctl kickstart -k` → health gates), env templates (`.env.example` additions, no secrets), `provision-native.sh` reduced to build-box duties, the `prod-deploy` skill rewritten for the mini.
- [ ] Tests: script unit tests where feasible (release swap/rollback dir logic with a temp root); `actionlint`-style YAML check; dry-run of `provision-macmini.sh --check` against the real mini (read-only checks: Node/pnpm present, dirs, plists valid via `plutil -lint`).
- [ ] Commit `feat(deploy): Mac mini host deploy`.

### Task 4 (controller): final review, docs, provision, cutover
- [ ] Final whole-branch review → fix wave → re-review; wiki (workspace.md rewrite, web-research, judge/eval touches, DEPLOYMENT.md, prod-deploy skill); handover; roadmap row 86.
- [ ] Mini cleanup (Hermes retired, old brew postgres stopped, disk reclaimed; BlueBubbles untouched) + provision + `gh auth login` as Patrity (Tony runs the interactive step).
- [ ] Confirm the window with Tony → cutover per spec §6 → acceptance (health, MCP, chat, workstream workspace command, LAN reachability, Brave search, iMessage, eval-world confinement (evals only — agent runs are unconfined under option C), bridget-core on prod).
