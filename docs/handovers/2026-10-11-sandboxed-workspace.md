---
title: Sandboxed workspace — per-workspace Docker sandbox, file/shell/watch tools, taint-aware network (cycle 82, harness step 3)
cycle: 82
date: 2026-10-11
status: built  # awaiting deploy and prod acceptance
branch: feat/sandbox (worktree .claude/worktrees/feat+sandbox, base 5c0d0c6)
merged: false
deployed: false
specs:
  - ../superpowers/specs/2026-10-11-sandboxed-workspace-design.md
plans:
  - ../superpowers/plans/2026-10-11-sandboxed-workspace.md
wiki:
  - ../wiki/workspace.md
  - ../wiki/agent.md
  - ../wiki/workstreams.md
  - ../wiki/core-package.md
  - ../wiki/agent-exec.md
migrations:
  - 0072 workspaces table
  - 0073 workspaces.inodes_used, tainted, tainted_at
  - 0074 workspace_shells, workspace_watches
  - 0075 workspace_watches.result_text, delivered_at
  - 0076 workspaces.ns (bus namespace)
new_units: [mymind-sandbox-net]  # systemd oneshot (re-applies the firewall at boot/docker restart); not a persistent service like mymind-worker
next: harness step 4 — coordinator (spec §10: out of scope here, along with judge, GPU, per-command network allowlists, multiple concurrent workspaces per workstream)
---

# Sandboxed workspace (cycle 82)

Bridget now gets a real workspace: files, shells, background processes, polling — inside a Docker
sandbox per workspace — instead of `exec`ing as root in LXC 114. Host `exec` moved to an on-demand
`admin` toolset (unchanged behaviour/gate; just no longer the default). Current-state reference:
[`wiki/workspace.md`](../wiki/workspace.md).

## What shipped, by task and fix wave

**Task 1 — sandbox runtime, `workspaces` table, network isolation** (`97afdc0`, fix rounds `2cd740d`,
`d480ed6`): `deploy/sandbox/Dockerfile` + `build-image.sh`; `lib/sandbox/docker.ts` (pure argv
builders, pinned flag-for-flag), `network.ts` (the firewall plan as data), `manager.ts`
(`ensureContainer`/`exec`/taint/quota/idle-stop/reconcile/sweep), `quota.ts`, `store.ts`; the
`workspaces` table; `install-network.sh install|apply` + the `mymind-sandbox-net` oneshot. Fix
rounds added **persistent taint** (review I1 ruling), the **disk watchdog** + inode floor (review
I2), and the **firewall reachability check** (review I3: dockerd's own `FORWARD → DOCKER-USER`
jump must be visible to the same `iptables`, not just our rules).

**Task 2 — `workspace` toolset, `admin` move, background shells + watches** (`46e742e`, fix round
`7c58f94`): the 12 original tools (`read_file`/`write_file`/`edit_file`/`list_files`/`grep`/
`diff`/`bash`/`bash_output`/`kill_shell`/`watch`/`export_to_document`/`import_document`), `exec`
moved to `admin`, background-shell registry (`workspace_shells`) and watch runtime
(`workspace_watches`), workspace selection (workstream thread → its workspace; everything else →
`home`), and the taint-widening decision that **reads** taint a workspace too (not just writes —
stricter than the spec's literal D5, because any command exposes its args to `/proc` for whatever an
earlier run left running). The fix round deleted an initial "allowlisted recovery commands inside
`bash`" design for over-quota handling in favour of **refuse `bash` entirely + a new `delete_files`
tool** (not in the spec's D3 list), and added the per-workstream watch caps (not in the spec either).

**Task 3 — secrets opt-in, Files/Shells UI** (`4b78fb2`, `904ed35`, `eea735b`; fix rounds `acfa3c0`,
`9bad4ae`, `51e41e5`, `f5efb53`): the `sandbox` opt-in on `exec_secrets`, the masking pipeline
(`lib/sandbox/secrets.ts`), the worker-side read path (`view.ts`, `workspace-view`/
`workspace-kill-shell` bus commands), the `/api/workspaces/**` routes, and the Files/Shells/
NetworkBanner UI. Fix rounds hardened masking at every cut edge (byte-exact `bash_output` windows,
`maskCut`), isolated in-container `python3 -I`, and made download/lookup failures show as app errors
instead of raw ones.

**Final fix wave — controller-dispatched, one wave, 16 commits** (`fec1cfe` … `73fdaad`, base
`f5efb53`): every Important/Minor finding from the whole-branch final review (I1–I7, M1–M8), every
item parked by the three task reviews, and the DB-test orphan-row root cause. See
[Deviations](#deviations-from-the-spec) below for what each one changed structurally.

## Commits

28 commits, base `5c0d0c6` → HEAD `73fdaad`, branch `feat/sandbox`. In order:

```
97afdc0 feat(sandbox): docker sandbox runtime, workspaces, network isolation
2cd740d fix(sandbox): persistent taint, disk watchdog, firewall reachability check
d480ed6 fix(sandbox): inode floor, fail-closed quota, taint-safe kill fallback, worker-side re-enable
46e742e feat(workspace): file, shell, background and watch tools in the sandbox
7c58f94 fix(workspace): deny bash over quota, delete_files, watch caps, taint-safe watches and exports
4b78fb2 feat(workspace): sandbox secrets opt-in, files and shells UI
904ed35 fix(workspace): drop the redundant opt-in filter in the secrets save path
eea735b fix(workspace): UI reads no longer re-publish an unchanged workspace; robust tree keys
acfa3c0 fix(workspace): mask watch output and cut edges, isolated python, download and lookup errors in-app
9bad4ae fix(workspace): pin the masked 1 MB view cut with a real-Docker test
51e41e5 fix(workspace): byte-exact bash_output windows; a failing secret store withholds instead of erroring
f5efb53 fix(workspace): describe the non-UTF-8 stream test accurately
fec1cfe fix(workspace): taint error results from a tainted workspace; mask secrets in exported documents
458c554 fix(sandbox): bound running sandboxes, verify limits, end shells and finished workstreams
edfb62e fix(workspace): fence watch output as untrusted, API-token reads never start a sandbox, friendly withheld errors
f966e72 fix(deploy): content-hash sandbox tag with pruning, sandbox warnings on the deploy run
6aec4b2 fix(workspace): show "Sandbox unavailable: <reason>" on workstreams and workspace pages
343bc11 fix(workspace): delete_files validates the whole batch first and refuses .mymind; a watch-cap pause keeps a pending question
4580d29 fix(sandbox): scope the worker's workspace scans to its bus namespace; DB tests label and remove every row they create
89f6fa1 fix(agent): steer every command to the workspace bash; host exec only for MyMind server ops
9b1e37d test(sandbox): retry firewall probes past the single-shot listener's respawn gap (parallel-run flake)
403b276 test(deploy): provisioning warnings, the 6 GB build floor, M7 messages and the oneshot's own copy
0e5418a test(sandbox): abort tests wait for the exec to start instead of a fixed sleep
7cd00ed test(sandbox): re-enable and hard-kill tests wait for the command instead of fixed sleeps
e7a0965 test(sandbox): a spawn-heavy firewall re-apply test gets a load-proof timeout
e7a798e test(agent): the cold agent-graph import test gets a load-proof timeout
6accc8d test(workstreams): the worker endpoint carries the sandbox preflight
73fdaad test(workstreams): remove the workspace rows its workstreams create (the dev DB's orphan source)
```

## Test counts

| Gate | Before (base `5c0d0c6`) | After (HEAD `73fdaad`) |
|---|---|---|
| `pnpm test` | 3709 passed / 1 skipped (349 files) | **3976 passed / 1 skipped** (363 files) |
| `pnpm test:db` | 959 (87 files) | **1028 passed** (93 files, full run including the real-Docker suites) |
| `pnpm typecheck` | green | green |
| `pnpm build` + worker build + `stage.mjs` | — | green ("Build complete!", worker bundle ~14.2 MB, "all externals load") |

Hundreds of mutation checks across all three tasks and the final fix wave, each run after a commit
and restored with `git checkout` (never stashed); every mutant reported went red (two malformed
mutants were fixed and re-run; see the task reports for the two that needed a second try). Several
timing-sensitive tests were rewritten to wait on an event instead of a fixed sleep after an
intermittent red at machine load average 55–80.

## Deviations from the spec

The spec (§1–§10) sets the intent; code + this handover are what actually shipped. Where they
differ:

1. **Secrets: `exec_secrets.sandbox` is `string[]` on the existing settings doc, not a new table
   with a per-secret boolean column.** `exec_secrets` is one encrypted JSON document (`settings`
   table, `key='exec_secrets'`), not a table of rows — a migration would have meant moving the
   encrypted store for a cosmetic schema preference. Spec intent ("per-secret `sandbox: boolean`,
   default false") is met; `MIN_SANDBOX_SECRET_CHARS = 4` (a value too short to mask safely can't be
   opted in) was added during the fix round and isn't in the spec.
2. **I7 — the 30-day deletion clock now starts at a workstream's terminal state, not only at
   deletion.** Spec D2/§3 said "kept until the workstream finishes + 30 days," but cycle 81 never
   built a workstream delete, so the clock could never start and every finished workstream's files
   were kept forever. The spec's §3 already carries the dated amendment note (final review I7);
   `store.listExpired` now also matches a workstream workspace whose workstream finished
   (done/failed/cancelled) with `finished_at` older than 30 days. A resumed workstream clears
   `finished_at`, so it's exempt until it finishes again.
3. **Capacity cap — `SANDBOX_MAX_RUNNING` (default 2) — is new, not in the spec.** The spec bounds
   each *container* (1.5 CPU / 2 GB / 512 pids) but says nothing about the aggregate; three active
   workstreams plus `home` could demand 8 GB / 4.5 CPU on an 8 GB / 2-CPU LXC that also runs
   Postgres, SearXNG and both app processes (final review I3). A start past the cap evicts the
   least-recently-used idle container, or waits up to 60 s, then fails with a clear error. One
   alternative — a shared parent cgroup slice — was considered and rejected: unprivileged LXC
   delegation of a parent slice is uncertain on the actual box.
4. **`bash` is refused outright over quota (every mode), and `delete_files` is new.** The spec's §2
   says "writes refused, background shells killed" with no bash policy. Task 1 initially shipped an
   allowlist parser letting read/delete-only pipelines run inside `bash` even over quota; Task 2's
   fix round deleted that entirely (deny by default — a parser is an attack surface) and added
   `delete_files({paths})` (batch `rm -rf --`, refuses `.mymind` and path escapes, validates the
   whole batch before deleting anything) plus `list_files({largest: true})` for finding what to
   delete. Neither tool is in the spec's §4 table.
5. **Watch caps are new.** The spec's `watch` row has no lifetime limit. Task 2's fix round added
   `MAX_ARMED_WATCHES = 5` per workspace, `MAX_WORKSTREAM_WATCHES = 10` over a workstream's whole
   lifetime, and `MAX_WORKSTREAM_WATCH_WAIT_MS = 48h` cumulative armed time — past either, `watch`
   refuses and pauses the workstream for Tony (watch-waiting costs no step budget, so without a cap a
   workstream could wait indefinitely).
6. **I4 — a resource-limits preflight (`SANDBOX_REQUIRE_LIMITS`) is new.** The spec assumes
   `--memory`/`--pids-limit` are enforced. On an unprivileged LXC whose cgroup controllers aren't
   delegated to Docker, those flags succeed with a silent "Limitation discarded" warning. The final
   fix wave added a probe (create a throwaway container, inspect `HostConfig`, read its own
   `/sys/fs/cgroup/{memory,pids}.max`) that fails the sandbox closed on a mismatch, cached 60 s —
   mirroring `SANDBOX_REQUIRE_FIREWALL`'s shape.
7. **I5 — the image tag is a content hash of `deploy/sandbox/`, not the git sha the spec names.**
   CD's tar excludes `.git`, so a git sha read on the box is the box's stale checkout, never the
   deployed commit. `build-image.sh` tags by `sha256(deploy/sandbox/)` instead, and added a prune
   policy (not in the spec) after the branch's own disk-cache incident pattern.
8. **I6 — a worker-heartbeat sandbox status + UI banner is new.** The spec has no health-reporting
   requirement. Final review found a failed sandbox setup could leave a green deploy with no signal
   anywhere Tony looks; `WorkerBeatStatus.sandbox` plus `AgentSandboxUnavailableBanner` plus a CD
   `::warning::` step close that gap.
9. **`workspaces.ns` (migration 0076) is new** — a bus-namespace column added in the final fix wave
   so the worker's background scans never touch another namespace's (e.g. a test run's) rows on the
   shared dev DB. Not in the spec; only the background scans are scoped by it (direct `get`s, the
   home-workspace uniqueness index and the API routes are not).
10. **M5 — API-token reads never start a stopped/tainted sandbox, and download is session-only.**
    Not specified either way; added because a leaked token (or a polling client) could otherwise keep
    2 GB containers running and read raw file bytes.

## Prod acceptance checklist

Nothing here has been run against the real LXC 114 yet — only Docker Desktop (dev Mac) and
docker-in-docker (the `sandbox-firewall.db.test.ts` suite, standing in for real netfilter). Run in
order; stop at the first failure. Source: `final-review.md`'s 10 probes plus the Task 1 ledger's own
notes for the controller.

**Pre-deploy**
1. `df -h /` and `df -i /` ≥ 8 GB free / plenty of inodes (the 671 MB image build + the 6 GB build
   floor + the 5 GB resume threshold all need headroom).
2. `docker system df`; `docker builder prune -f` if the cache is large.
3. `docker info`: no "No memory limit support" / "No swap limit support" / pids warnings;
   `Cgroup Version: 2`. **Also (Task 1 ledger): `docker info --format '{{.FirewallBackend}}'` must
   report `iptables`.**
4. `iptables -V` (nf_tables vs legacy) must match what dockerd uses (`iptables -S DOCKER` non-empty).
   **`iptables -S` must show `-N DOCKER` and `-A FORWARD -j DOCKER-USER` as the FIRST rule of
   FORWARD** (Task 1 ledger note, folded into `checkIsolation`'s own check — confirm it agrees).

**Post-deploy, firewall and network**
5. `systemctl is-enabled mymind-sandbox-net` and `iptables -S MYMIND-SANDBOX-FWD`/`-IN` must match
   the plan in `network.ts`.
6. Inside a sandbox: `curl -m5 127.0.0.1:5432`, the LXC's own IP on `:3000` and `:5432`,
   `172.31.82.1` (the sandbox gateway), `192.168.2.1`, `192.168.2.50:8006` and `169.254.169.254`
   must all fail fast ("prohibited"); `curl -sI https://example.com` and `getent hosts github.com`
   must succeed; `cat /proc/1/environ | tr '\0' '\n'` must show only `HOME`/`PATH`/`LANG`; `ls /opt`
   must not show `mymind`; `id` must be `10001`; `ip -6 addr` must be empty. Worth adding: the public
   MyMind URL, to confirm only the unauthenticated login surface answers (hairpin NAT reachability —
   accepted by design, but unverified on the real WAN path).

**Post-deploy, limits**
7. `docker inspect mymind-ws-<id> --format '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}
   {{.HostConfig.NanoCpus}}'` must print `2147483648 512 1500000000`. Then `python3 -c
   'a=bytearray(3*1024**3)'` must come back `oom: true`; a fork bomb with a 20 s timeout must hit the
   pids limit while the LXC keeps working (worker heartbeat stays fresh). **This is the probe the I4
   preflight claims to guarantee in software — it has only run against Docker Desktop and unit fakes,
   never the real LXC. If the controllers aren't delegated, the sandbox should refuse itself
   (`SANDBOX_REQUIRE_LIMITS=true` is the Linux default) rather than silently run unbounded — confirm
   it does.**
8. `statfs` of `/opt/mymind` must report free space consistent with `df` (Task 1 ledger note — the
   watchdog trusts `statfs` directly). `df -i /` to see whether the inode floor is actually live
   (ext4/LVM) or inert (ZFS, which has no fixed inode table and skips the check by design).

**Post-deploy, taint**
9. A tainted turn (read one Gmail message, then `bash curl -m5 https://example.com`) must show
   `networkOff`, `workspaces.tainted=true`, and the networked container stopped. Re-enable network
   from the UI and confirm it works again.

**Post-deploy, reboot persistence**
10. `pct reboot 114`. The firewall rules must be present before the worker's first sandbox command,
    and `journalctl -u mymind-sandbox-net` must be clean.

**Post-deploy, lifecycle**
11. A workstream writes a file, runs a script, starts a background job, watches it, and finishes.
    After 15 idle minutes (plus the next minute tick), its container must be stopped — this is the
    probe that would catch an I2 regression (a live shell with no watch and no output read no longer
    pins the container).

## Deferred and backlog

- **Shell/watch output pruning.** `workspace_shells`/`workspace_watches` rows (and their
  `.mymind/shells/<id>/` output files, which count toward quota) are never pruned after they end.
  Parked across every task review (M6).
- **Document-level taint.** A tainted run's `create_document`, later read by an untainted
  workstream's `import_document`, does not propagate taint into the workspace it's imported into.
  Parked (M7, declined-to-judge in the final review).
- **Image prune policy follow-ups.** `docker builder prune --filter until=24h` clears **all**
  BuildKit cache older than 24h, not scoped to the sandbox image (the brief asked for scoped). The
  content hash covers every file in `deploy/sandbox/` including `install-network.sh`/
  `build-image.sh` themselves, so a change to those adds a new tag without rebuilding any layer (the
  image id is unchanged and the prune correctly keeps it, but the tag list grows).
- **The `workspaces.ns` migration only scopes background scans.** Direct `get`s, the home-workspace
  uniqueness index, and every `/api/workspaces/**` route are not namespace-scoped. Fine for a
  single-namespace prod box; worth a second look if a second namespace is ever run against the same
  DB outside tests.
- **I2 semantic change, worth remembering operationally:** a live background shell no longer
  prevents its container's idle-stop by itself (only its *eviction* for capacity). A long job with
  no armed `watch` and no `bash_output` read for 15 minutes is killed with its container — this is
  the ruling, not a bug, but it means "start it and walk away" no longer works for anything longer
  than 15 minutes unless something polls its output or a `watch` is armed on it.
- **I3 cost:** every container start now does a `docker ps` + `inspect` under a single global
  capacity lock, so starts serialize, and a start can wait up to 60 s (from request entry, outside the
  workspace lock, abortable) when both workstream slots hold live shells or in-flight commands.
  Follow-up N1: home has a reserved slot outside the cap; watch-only containers are evictable; N4
  teardown re-checks terminal state under the lock (`stopIf`). One eviction's `docker stop` can still
  hold the capacity lock up to 30 s if Docker hangs. Not measured against real concurrent load.
- **Prod DNS unverified.** Sandboxes resolve through Docker's embedded DNS (forwards from the
  container's own netns — a LAN resolver like the router would be rejected by the firewall by
  design), so sandboxes get `1.1.1.1`/`9.9.9.9` explicitly on Linux. Whether LXC 114's host network
  allows outbound UDP/53 to those has not been checked; `SANDBOX_DNS` overrides it if needed.
  (Docker Desktop on the dev Mac blocks outbound UDP/53 entirely, which is why this wasn't caught in
  dev — macOS keeps Desktop's own resolver instead.)
- **Rebuilding the image recreates every running container** on the next worker boot reconcile
  (files are kept; any running background shell in that container is lost). Expected, not a defect —
  worth knowing before a deploy that only changes `deploy/sandbox/`.
- **Thread summarization can paraphrase tainted content.** `runtime/summarize.ts` folds only message
  *text* into a thread summary, not tool results — so Bridget's own paraphrase of tainted workspace
  content could end up in a summary untainted. Pre-existing (the same is true of Gmail content
  today); not fixed in this cycle.
- **Commit `458c554` alone does not typecheck** (it imports a watches option that lands in the next
  commit, `edfb62e`) — HEAD is green throughout, but don't `git bisect` across the final fix wave
  without checking out the whole wave together.
- **Machine-load test flakiness.** Two pre-existing tests (the cold agent-graph import, a
  spawn-heavy firewall re-apply test) needed explicit longer timeouts after going red at a measured
  load average of 55–80 on the build machine; on a quiet machine they pass in 2–3 s. Not sandbox
  code, just noted so a future red isn't mistaken for a regression.
