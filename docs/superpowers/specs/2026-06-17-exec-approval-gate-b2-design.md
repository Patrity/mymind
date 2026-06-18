---
title: Approval-Gate Harness + Constrained Exec (Cycle B, Phase 2)
date: 2026-06-17
status: design
cycle: 30
related:
  - 2026-06-17-web-research-b1-design.md
  - 2026-06-17-agent-surface-chat-design.md
  - ../../handovers/2026-06-17-agent-surface-chat.md
  - ../../wiki/agent.md
---

# Approval-Gate Harness + Constrained Exec (Cycle B, Phase 2)

**B2** is the security keystone of Cycle B: a human-in-the-loop **approval gate** that pauses a dangerous tool call until Tony approves it in the UI, plus a first **`exec`** tool that runs as a constrained child process. The gate is tool-agnostic — B3 (`gh`/file-edit) and B4 (`ssh`) ride the same harness. This is the cycle that introduces real command execution, so the design is security-first and honest about its isolation level.

## Locked Cycle-B decisions (context)

1. **Native tools in `runAgent`** — one loop (cycle-28 convergence). No separate executor service, no delegation to an external agent runtime.
2. **Hard approval gate + constrained exec** — read-only tools auto-run; dangerous tools (exec, later ssh/file-write) pause for an in-UI Approve/Deny with a **remembered, persisted, editable allowlist** (user decision, B2 brainstorm).
3. **Deploy reality:** MyMind runs as a Docker container inside an unprivileged Proxmox LXC. A true nested sandbox (bwrap/nsjail) is unreliable there; isolation is least-privilege-user + workspace-jail + the container boundary + the gate.

## Goal

In a **powerful**-profile conversation, Bridget can propose a shell command; the turn pauses; Tony sees the exact command and Approves or Denies (optionally "always allow commands like this"); on approve it runs in a constrained `/workspace` sandbox and the output flows back into the turn. Normal (safe-profile) conversations can never reach exec.

## Architecture

### 1. Opt-in surface — the `powerful` profile + switcher
- A second `AgentProfile`, **`powerful`** (`server/lib/agent/profile.ts`): `{ id:'powerful', tools:[...bridgetProfile.tools, execTool], personaKey:'agent_persona' }`. The default `bridget` profile is unchanged (gated tools are absent from it).
- `/agent` gains a **profile toggle** (per-conversation; default = `bridget`/safe). The client sends the chosen profile to the WS (`{type:'profile', profile:'bridget'|'powerful'}`); `ConnState.profile` carries it; the turn passes `ctx.profile` into `runAgent`. Persisting the profile on the conversation row is an optional follow-on (B2 keeps it per-connection, defaulting to safe on resume).

### 2. Approval-gate harness (tool-agnostic)
- **`AgentTool` gains `dangerous?: boolean`** (`server/lib/agent/types.ts`). Orthogonal to `kind` (a dangerous tool is still read/create/destructive for undo purposes).
- **`ToolContext` gains `requestApproval?(req): Promise<{ approved: boolean }>`** where `req = { tool: string; command: string; proposedPattern: string }`.
- **`buildAiTools` wrapper** (`server/lib/agent/ai-tools.ts`): for a `dangerous` tool, *before* running the handler, call `ctx.requestApproval(req)`. If approved → run the handler as normal. If denied → skip the handler and return a `ToolExecution`-shaped `{ result: { denied: true }, summary: 'denied by Tony' }` so the model is told plainly and continues. **Fail-safe:** if `requestApproval` is absent (e.g. the headless SSE path), a dangerous tool auto-denies.
- **`requestApproval` implementation** (provided by the WS/orchestrator, threaded `WS → handleTurn deps → runAgent ctx → buildAiTools`):
  1. **Allowlist check** (DB): if an approved pattern matches `command`, return `{approved:true}` immediately — no UI round-trip.
  2. Else create a `requestId` + a deferred; store it in a per-connection `pendingApprovals: Map<string, Deferred>`; emit an approval-request event (`hooks.onEvent` → orchestrator `VoiceEvent` → WS → peer) `{ type:'approval', requestId, tool, command, proposedPattern }`; `await` the deferred.
  3. A new WS control frame **`{ type:'approve'|'deny', requestId, remember?: boolean }`** is handled **immediately** by the message handler (like `interrupt`/`load` — not queued behind the turn lock), resolving the deferred. On `approve`+`remember`, persist the pattern (§3). 
  4. **Timeout** (`APPROVAL_TIMEOUT_MS`, e.g. 120_000): the deferred auto-resolves `{approved:false}` so a turn never hangs; the UI request expires.
- This works with the existing WS architecture: the turn runs under `s.lock` but `await`s the deferred without blocking the event loop, so the approve/deny frame is processed and resolves it (confirmed against `ws.ts`).

### 3. Persisted allowlist
- **New table `exec_approvals`** (migration): `id`, `pattern` (text — binary + an editable glob, e.g. `git *`, `ls *`), `tool` (text, e.g. `exec`), `created_at`, `last_used_at`. A pure **matcher** `matchesApproval(command, patterns): boolean` (glob→anchored-regex, anchored to the start so `rm *` can't match inside another command).
- A `proposedPattern` is derived from the command (binary + `*`) and shown in the UI as the "always allow" suggestion (Tony can edit it before saving).
- Managed in a new **`/settings → Agent Tools`** tab: list patterns (with `last_used_at`), add/edit/revoke. `GET`/`DELETE`/`PUT /api/settings/exec-approvals`. Patterns are kept specific; a bare `*` is rejected by validation.

### 4. Constrained `exec` tool + sandbox
- **`exec` tool** (`server/lib/agent/tools.ts` or a new `server/lib/agent/tools/exec.ts`): `{ command: string, cwd?: string }`, `kind:'destructive'`, `dangerous:true`. `proposedPattern` = first token + ` *`.
- **Runner** (`server/lib/exec/run.ts`): `runConstrained(command, opts)` spawns via `node:child_process` with:
  - **`uid`/`gid` of a dedicated low-priv `agent` user** (the parent Nitro process runs as root in the container so it can setuid the child; if it cannot, exec fails closed with a clear error rather than running as the app user);
  - **`cwd` jailed to `/workspace`** (the `cwd?` arg is resolved + must stay within `/workspace`, else rejected);
  - **stripped env** — an explicit minimal allowlist (`PATH`, `HOME=/workspace`, `LANG`); never `DATABASE_URL`/`BETTER_AUTH_SECRET`/`CONFIG_ENC_KEY`/provider keys/`SEARXNG_SECRET`;
  - **timeout** (`EXEC_TIMEOUT_MS`, e.g. 60_000) → kill the process group;
  - **output cap** (e.g. 64KB stdout+stderr, truncated with a marker);
  - rlimits where the platform supports them (best-effort).
  - Returns `{ exitCode, stdout, stderr, timedOut }`.
- **Dockerfile** (`Dockerfile`): create the non-root `agent` user + group; create `/workspace` owned by `agent`. **`docker-compose.prod.yml`**: a persistent `mymind-workspace` volume mounted at `/workspace`. The shared `/workspace` is where B3's file-edit + report rendering will also operate.

### 5. Logging + safety
- Every gated decision + exec records to the existing **activity log** (`withSpan`/`recordEvent`): the command, the approve/deny/timeout outcome, the exit code, and truncated output (secrets already scrubbed at the choke point — and exec env is stripped anyway). Denials and timeouts are first-class events, not errors.
- **Honest isolation statement** (carried into the wiki): exec is protected by (a) the powerful-profile opt-in, (b) the hard per-command approval gate, (c) a least-privilege `agent` user, (d) a `/workspace` cwd-jail, (e) a stripped env, and (f) the container boundary. It is **not** a true syscall sandbox; a compromised command running as `agent` could still read world-readable files inside the container and make outbound network calls. The gate + least-privilege + stripped-secrets are the defense; a stronger sandbox is a future hardening if the LXC ever supports it.

## Components / file structure (for the plan)

- `server/lib/agent/profile.ts` — add `powerfulProfile`.
- `server/lib/agent/types.ts` — `dangerous?` on `AgentTool`; `requestApproval?` on `ToolContext`.
- `server/lib/agent/ai-tools.ts` — the dangerous-tool interception.
- `server/lib/exec/run.ts` — `runConstrained` (the sandboxed spawn).
- `server/lib/exec/approvals.ts` — `matchesApproval` (pure) + the `exec_approvals` store (load/add/delete).
- `server/lib/agent/tools/exec.ts` — the `exec` tool.
- `server/db/schema/exec-approvals.ts` + migration.
- `server/api/voice/ws.ts` — `profile` + `approve`/`deny` control frames; the `requestApproval` implementation + `pendingApprovals` map; thread into the turn.
- `server/lib/voice/orchestrator.ts` + `server/lib/agent/run.ts` — thread `requestApproval` + `profile`.
- `server/api/settings/exec-approvals.{get,put,delete}.ts` + `app/components/settings/AgentToolsTab.vue` + `settings.vue` — allowlist management.
- `app/pages/agent/index.vue` + `app/composables/useVoice.ts` — profile toggle + the approval prompt UI (Approve/Deny + "always allow" + editable pattern) over the WS.
- `Dockerfile`, `docker-compose.prod.yml` — `agent` user + `/workspace` volume.

## Testing

- **Pure unit (vitest):** `matchesApproval` (anchoring, glob edge cases, bare-`*` rejection); env-stripping (secrets excluded, allowlist kept); the cwd-jail resolver (rejects `..`/absolute escapes from `/workspace`); the approval-decision reducer (approve/deny/timeout → outcome); `proposedPattern` derivation.
- **Playwright E2E** (`browser-testing` skill): switch a conversation to **powerful** → ask Bridget to run a command → the **approval prompt** appears with the exact command → **Approve** runs it in `/workspace` and the output returns; **Deny** → the model is told and continues; **"always allow"** persists the pattern (appears in `/settings → Agent Tools`) and a repeat of that command runs **without** a prompt; a **non-allowlisted** command re-prompts; the **safe profile** has no exec. Negative: a command attempting to `cd` outside `/workspace` is rejected; the stripped env means `echo $DATABASE_URL` returns empty.

## Out of scope (B2)

- B3 (gh read, file-edit, report/visualization rendering on this harness) and B4 (ssh) — separate cycles.
- A true syscall sandbox (bwrap/nsjail/gVisor) — documented as future hardening, infeasible in the current unprivileged LXC.
- Persisting the chosen profile per-conversation (per-connection in B2; optional follow-on).
- Streaming live exec output token-by-token (B2 returns the buffered, capped result; a live PTY stream is a later enhancement).

## Open follow-ons

- B3, B4 on this harness.
- Per-conversation persisted profile.
- Live exec output streaming (PTY) — you've built a WS-PTY before (claude-agent); reuse if/when wanted.
- Stronger sandbox if the deploy env gains nested-namespace support.
