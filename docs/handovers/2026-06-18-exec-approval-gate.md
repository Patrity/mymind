---
title: Approval-Gate Harness + Constrained Exec (Cycle B2)
cycle: 30
date: 2026-06-18
status: shipped
branch: feat/exec-gate-v2
spec: ../superpowers/specs/2026-06-17-exec-approval-gate-b2-design.md
plans:
  - ../superpowers/plans/2026-06-17-exec-approval-gate-b2.md
wiki:
  - ../wiki/agent-exec.md
shipped:
  - "**Powerful profile + per-connection toggle** (`server/lib/agent/profile.ts`): `powerfulProfile` = safe `agentTools` + `execTool`, same `agent_persona` personaKey. `profileById(id)` falls back to `bridgetProfile`. `/agent` navbar gets a `USwitch` \"Powerful tools\" toggle (per-session, not cookie-persisted, defaults safe on every load); sends `{ type: 'profile', profile }` WS frame; `ConnState.profile` carries the selection into every turn."
  - "**Tool-agnostic approval gate** (`server/lib/agent/ai-tools.ts`): `buildAiTools` intercepts `dangerous: true` tools before the handler runs. Calls `ctx.requestApproval(approvalRequestFor(t, input))`; if `approved === true` (strict) → handler runs; else returns `{ denied: true }` to the model. Fail-safe: missing `requestApproval` (headless SSE path) auto-denies — dangerous tools can never run without an explicit channel. `describeApproval` method on `AgentTool` produces the request; fallback is `JSON.stringify(input)` + `'<name> *'`."
  - "**`exec` tool** (`server/lib/agent/tools/exec.ts`): `kind: 'destructive'`, `dangerous: true`, schema `{ command, cwd? }`. `describeApproval` returns `proposedPattern(command)` = `<first-token> *`. On `ExecDisabledError` (fail-closed or jail violation) returns `{ disabled, error }` to the model rather than throwing a system error."
  - "**Constrained runner** (`server/lib/exec/run.ts`): `runConstrained` — `selectExecMode` picks `setuid` (root + `EXEC_AGENT_UID` set) / `unconfined` (non-prod + `EXEC_UNCONFINED=1`) / `disabled` (fails closed). `buildSpawnArgs` in `setuid` mode uses `setpriv --reuid --regid --clear-groups -- /bin/sh -c <cmd>` to fully drop privileges including supplementary groups (Node `spawn({ uid, gid })` leaves root's supplementary groups intact). `resolveExecCwd` jails the cwd lexically to `workspaceRoot` (default `/workspace`). `buildExecEnv` constructs the child env from scratch: only `PATH`, `HOME=workspaceRoot`, `LANG=C.UTF-8` — no app secrets can reach the child. Timeout (`EXEC_TIMEOUT_MS`, default 60 s) kills the process group. Output cap 64 KB/stream with `…[output truncated]` marker. Pre-spawn abort guard. Returns `{ exitCode, stdout, stderr, timedOut, aborted, mode }`."
  - "**Persisted allowlist** (`server/lib/exec/approvals.ts` + migration `0024_clever_psylocke.sql`): `exec_approvals` table (`id` uuid PK, `pattern`, `tool`, `created_at`, `last_used_at`; unique on `(tool, pattern)`). `matchesApproval` compiles `*` to a non-chaining char class anchored `^...$` — `*` never spans `;`, `&&`, `|`, backticks, `$()`, `<>`, or newlines, so an approved prefix cannot be tricked into a second command. `validatePattern` rejects bare `*`. `proposedPattern` = `<first-token> *`. `approvalOutcome` maps approve/deny/timeout events to `{ approved, persist, pattern }`. Store: `loadApprovals`, `addApproval` (validates + `onConflictDoNothing`), `updateApproval`, `deleteApproval`, `touchApproval`."
  - "**WS protocol additions** (`server/api/voice/ws.ts`): `ConnState` gains `profile` (default `'bridget'`) and `pendingApprovals: Map<requestId, { resolve, timer, req }>`. New client→server frames: `profile` (immediate, not queued), `approve` (immediate, resolves pending), `deny` (immediate, resolves pending). New server→client frames: `approval` (paused dangerous call), `approval-resolved` (timeout). `requestApproval` impl: (1) allowlist check → fast-path `{ approved: true }` + `touchApproval` + `allowlisted` log; (2) else emit `approval` frame, store deferred with 120 s auto-deny timer (`APPROVAL_TIMEOUT_MS`); approve/deny/interrupt/close all clean up pending approvals."
  - "**`/settings → Agent Tools` tab** (`server/api/settings/exec-approvals.{get,put,delete}.ts` + `app/components/settings/AgentToolsTab.vue`): `GET` lists all patterns; `PUT` adds (body `{ pattern }`) or updates (body `{ id, pattern }`); `DELETE ?id=` revokes. Tab renders allowlisted patterns with `last_used_at`, inline edit (blur/Enter saves), revoke button, and a new-pattern input. Bare `*` rejected server-side."
  - "**Client approval prompt** (`app/components/agent/ApprovalPrompt.vue` + `app/pages/agent/index.vue` + `app/composables/useVoice.ts`): `ApprovalPrompt` renders inline in the transcript panel when `voice.pendingApproval` is set — shows tool + command, editable `proposedPattern` with \"Always allow\" checkbox, Approve/Deny buttons. `useVoice` exposes `pendingApproval` ref, `sendApproval(requestId, approved, opts?)`, `setProfile(profile)`. `approval`/`approval-resolved` WS frames set/clear `pendingApproval`."
  - "**Deploy** (`Dockerfile`, `docker-compose.prod.yml`): runtime stage installs `util-linux` (provides `setpriv`); creates `agent` group + user (uid/gid 10001), `/workspace` owned by `agent`; bakes `EXEC_AGENT_UID=10001`, `EXEC_AGENT_GID=10001`, `EXEC_WORKSPACE_DIR=/workspace`. Compose adds a persistent `mymind-workspace` named volume mounted at `/workspace` (shared exec cwd-jail, will also host B3 file-edit/report artifacts)."
  - "**Migration 0024** (`0024_clever_psylocke.sql`): `exec_approvals` table. Applies automatically on container start via `pnpm db:migrate` in the Dockerfile CMD. Local `db:migrate` was skipped during the build (no `DATABASE_URL` in the worktree) — will apply on deploy/CI."
validation:
  - "**Typecheck**: 0 errors."
  - "**Tests**: 491/491 passing (79 test files) — covers `matchesApproval` (anchoring, glob edge cases, bare-`*` rejection, chaining-safe `*` semantics), `validatePattern`, `proposedPattern`, `approvalOutcome`, `buildExecEnv` (secrets excluded, allowlist kept), `resolveExecCwd` (rejects `..`/absolute escapes), `selectExecMode` (fail-closed paths), `buildSpawnArgs` (setpriv args for setuid mode)."
  - "**Build**: clean."
  - "**Migration 0024**: present and correct; applies on deploy/CI."
  - "**Playwright E2E**: pending — the controller runs the full browser-testing validation after this task. Dev happy-path (powerful toggle → command → prompt → approve/deny/always-allow → allowlist in settings → non-allowlisted re-prompt → jail violation → stripped-env) is exercisable locally with `EXEC_UNCONFINED=1 EXEC_WORKSPACE_DIR=/tmp/mymind-workspace pnpm dev`."
  - "**Two-stage per-task reviews** (subagent-driven, 10 tasks): security findings caught and fixed during review — (1) setpriv `--clear-groups` added (supplementary group drop; Node `spawn({uid,gid})` leaves root groups intact); (2) abort signaling fixed (pre-spawn abort guard + `AbortSignal` event listener on the child); (3) `approved === true` strict equality in `buildAiTools` (prevents truthy-but-not-boolean bypass); (4) `addApproval` tool-scoping (pattern persisted with the correct `tool` from the pending request, not a hardcoded default); (5) `AgentToolsTab` revoke/reload ordering (reload after delete so the list stays consistent); (6) `approval-resolved` frame unwrap (client correctly clears `pendingApproval` on timeout)."
  - "**Live prod setuid happy-path**: pending — the real `setpriv` code path (root process + `agent` uid 10001 + `/workspace` volume) validates on the next homelab deploy. Dev validates all logic via the `EXEC_UNCONFINED` escape hatch."
deferred:
  - "**Cycle B3**: `gh` (GitHub read), file-edit, and report/visualization rendering — ride this same harness (`dangerous: true` + `requestApproval`); separate cycle."
  - "**Cycle B4**: SSH — same harness; separate cycle."
  - "**Live prod setuid validation**: the `setpriv` path validates on the next homelab deploy; dev uses `EXEC_UNCONFINED=1`."
  - "**Per-conversation persisted profile**: profile is per-connection in B2 (defaults safe on every resume/load). Persisting the chosen profile on the `conversations` row is an optional follow-on."
  - "**PTY streaming**: B2 buffers the full capped output before returning it to the model. Live token-by-token exec output via a WS PTY stream is a future enhancement (architecture is proven from prior work)."
  - "**Stronger sandbox**: bwrap/nsjail/gVisor is infeasible in the current unprivileged Proxmox LXC. Documented as future hardening. The current isolation model is honest and sufficient for the threat model."
---

# Approval-Gate Harness + Constrained Exec (Cycle B2)

This is **Cycle 30 / Cycle B2**, the security keystone of Cycle B. It shipped the human-in-the-loop **approval gate** for dangerous tool calls and the first `exec` tool that runs shell commands as a constrained child process.

The gate is tool-agnostic — any tool marked `dangerous: true` pauses before execution and emits an `approval` frame to the client; Tony approves or denies inline in the transcript. A persisted glob-pattern allowlist (`exec_approvals` table) lets pre-approved command shapes skip the prompt automatically. The allowlist uses an anchored, chaining-safe `*` glob that cannot be tricked by metacharacter injection.

The `exec` tool runs via `setpriv --reuid --regid --clear-groups` to fully drop root's supplementary groups down to the dedicated `agent` user (uid 10001), confined to a `/workspace` cwd-jail, with an allowlist-constructed stripped environment (no app secrets reach the child). The runner fails closed — if it cannot drop privileges it throws `ExecDisabledError` rather than running as the app user. A dev escape hatch (`EXEC_UNCONFINED=1`, non-production only) allows local testing without the full setuid path.

The Dockerfile installs `util-linux` (setpriv), creates the `agent` user/group, and sets the workspace envs. A persistent `mymind-workspace` Docker volume is the exec cwd-jail (also reserved for B3 file artifacts).

**Honest isolation**: exec is protected by the powerful-profile opt-in, the hard per-command approval gate, a least-privilege `agent` user with full supplementary-group drop, a `/workspace` cwd-jail, a stripped environment, and the Docker container boundary. It is **not** a true syscall sandbox. A compromised command running as `agent` could still read world-readable files inside the container and make outbound network calls. The gate, least-privilege user, and stripped secrets are the principal defenses; a stronger sandbox is future hardening if the LXC ever supports nested namespaces.

See [`wiki/agent-exec.md`](../wiki/agent-exec.md) for the full "how it works today" reference.

## What's next

Cycle B3 (`gh` read, file-edit, report/visualization rendering) and B4 (ssh) ride this harness unchanged — both will be `dangerous: true` tools using `requestApproval` and the same `exec_approvals` allowlist infrastructure.
