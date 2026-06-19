---
title: Agent Exec — Approval Gate + Constrained Exec (Cycle B2)
status: shipped
cycle: 30
updated: 2026-06-18
---

# Agent Exec — Approval Gate + Constrained Exec (Cycle B2)

This is the security keystone of Cycle B. It added a human-in-the-loop **approval gate** that pauses dangerous tool calls until Tony approves or denies them in the UI, plus the first **`exec`** tool that runs shell commands as a constrained child process. The gate is tool-agnostic — Cycle B3 (`gh`/file-edit) and B4 (`ssh`) ride the same harness.

## The `powerful` profile + per-connection toggle

`server/lib/agent/profile.ts` defines two profiles:

- **`bridgetProfile`** (default/safe) — all standard tools (`agentTools`), no dangerous tools. Normal conversations stay on this profile.
- **`powerfulProfile`** (opt-in) — all safe tools **plus** `execTool`, personaKey `agent_persona`.

`profileById(id)` resolves a profile by string id, defaulting to `bridgetProfile` for unknown values.

The `/agent` page exposes a **"Powerful tools"** `USwitch` in the navbar. The toggle is **per-session** (not cookie-persisted), so every page load defaults to the safe profile. Toggling it sends `{ type: 'profile', profile: 'bridget' | 'powerful' }` to the WS; the `ConnState.profile` field carries the current selection; subsequent turns pass the resolved profile into `runAgent`.

The safe profile never includes `execTool`, so a non-powerful session literally cannot invoke the exec tool.

## Tool-agnostic approval gate (`buildAiTools`)

`server/lib/agent/ai-tools.ts` wraps every tool in the `buildAiTools` function. For tools marked `dangerous: true`, the wrapper:

1. Calls `ctx.requestApproval(approvalRequestFor(t, input))` before running the handler.
2. If `approved === true` (strict equality) → proceeds to the handler.
3. If not approved (deny, timeout, or missing `requestApproval`) → returns `{ denied: true }` so the model is told plainly and continues without executing.
4. **Fail-safe**: if `requestApproval` is absent (e.g., the headless SSE path), the tool auto-denies. Dangerous tools can never run without an explicit approval channel.

`approvalRequestFor` uses the tool's optional `describeApproval` method; if absent, it falls back to `{ tool, command: JSON.stringify(input), proposedPattern: '<name> *' }`.

## WebSocket protocol additions

`server/api/voice/ws.ts` added the following frames:

**Client → server:**
| Frame | Purpose |
|---|---|
| `{ type: 'profile', profile: 'bridget' \| 'powerful' }` | Switch profiles per-connection (processed immediately, not queued behind the turn lock) |
| `{ type: 'approve', requestId, remember?, pattern? }` | Approve a pending tool call; optionally persist the pattern to the allowlist |
| `{ type: 'deny', requestId }` | Deny a pending tool call |

**Server → client:**
| Frame | Purpose |
|---|---|
| `{ type: 'approval', requestId, tool, command, proposedPattern }` | Emitted when a dangerous tool call needs approval |
| `{ type: 'approval-resolved', requestId }` | Emitted when a pending approval times out (120 s auto-deny) |

`approve`/`deny` frames are processed **immediately** (like `interrupt`) — not queued behind the turn lock — so the awaiting turn unblocks while the turn itself is still suspended under the serializing lock.

`ConnState.pendingApprovals` is a `Map<requestId, { resolve, timer, req }>`. On connection close or a new interrupt, all pending approvals are auto-denied.

## `requestApproval` implementation

The `requestApproval` function injected into the turn:

1. Loads patterns from `exec_approvals` filtered to the tool and matching the command via `matchesApproval`. If a match is found, `touchApproval` updates `last_used_at`, logs an `allowlisted` event, and returns `{ approved: true }` immediately — no UI round-trip.
2. Otherwise, allocates a `requestId` (UUID), stores a deferred promise + a 120 s timeout in `pendingApprovals`, and emits the `approval` frame to the client.
3. The deferred resolves when the client sends `approve`/`deny`, or auto-resolves `{ approved: false }` at timeout with an `approval-resolved` frame and a `timeout` activity event.

## Allowlist — `exec_approvals` table + pattern semantics

**Schema** (migration `0024_clever_psylocke.sql`): `exec_approvals` table with `id` (uuid PK), `pattern` (text), `tool` (text, default `exec`), `created_at`, `last_used_at`. Unique on `(tool, pattern)`.

**`matchesApproval(command, patterns)`** (`server/lib/exec/approvals.ts`):
- Anchored glob matching: `*` compiles to a character class `[^;&|` + "`" + `$()<>\n\r]*` — shell metacharacters that chain or compose commands.
- Anchored to the start **and** end: `^<compiled>$`. A pattern like `git *` cannot be tricked into matching a command that has `git status && rm -rf /` because `*` never spans `;&|` etc.
- Bare `*` (pattern is just wildcards) is rejected by `validatePattern` — a pattern must contain at least one literal character.

**`proposedPattern(command)`** derives the suggested allowlist pattern from the command: `<first-token> *`.

**`approvalOutcome(event)`** maps an `approve`/`deny`/`timeout` decision event to `{ approved, persist, pattern }`.

### `/settings → Agent Tools`

`AgentToolsTab.vue` at `/settings → Agent Tools` lists all allowlisted patterns with `last_used_at`, allows adding new patterns, editing existing ones (inline, blur or Enter saves), and revoking patterns. A bare `*` is rejected server-side. The API endpoints are:
- `GET /api/settings/exec-approvals` — list all patterns
- `PUT /api/settings/exec-approvals` — add (body `{ pattern }`) or update (body `{ id, pattern }`) a pattern
- `DELETE /api/settings/exec-approvals?id=` — revoke a pattern

## `runConstrained` — the exec runner

`server/lib/exec/run.ts`. Every exec goes through this function; it is fail-closed by design.

### Privilege drop — `selectExecMode` + `setpriv`

`selectExecMode` chooses one of three modes:

| Mode | Condition |
|---|---|
| `setuid` | Process is root (`uid === 0`) AND `EXEC_AGENT_UID` is set to a non-root uid |
| `unconfined` | `NODE_ENV !== 'production'` AND `EXEC_UNCONFINED=1` (dev escape hatch only) |
| `disabled` | Anything else — exec fails closed with `ExecDisabledError` |

In production, `unconfined` is never reachable (the `NODE_ENV !== 'production'` guard prevents it). If the server cannot drop privileges, exec throws `ExecDisabledError` and the model is told; it never runs as the app user.

**`buildSpawnArgs`** in `setuid` mode uses `setpriv --reuid <uid> --regid <gid> --clear-groups -- /bin/sh -c <command>`. Node's `spawn({ uid, gid })` leaves root's supplementary groups intact; `setpriv --clear-groups` is the only safe path to a fully-dropped privilege set.

The runtime container uses uid/gid `10001` (`agent` user, created in the Dockerfile), with `EXEC_AGENT_UID=10001` and `EXEC_AGENT_GID=10001` baked into the image's `ENV`.

### CWD jail — `resolveExecCwd`

The workspace root is `EXEC_WORKSPACE_DIR` (defaults to `/workspace`). The `cwd` argument from the model is resolved via `path.resolve(workspaceRoot, cwd)`. If the result does not start with `workspaceRoot + sep`, an error is thrown before spawn. The jail is **lexical** (no `realpath`); symlink confinement is not claimed and relies on the uid boundary and container.

### Stripped environment — `buildExecEnv`

The child environment is **constructed from scratch** (allowlist-by-construction): only `PATH`, `HOME` (set to the workspace root), and `LANG=C.UTF-8`. No `DATABASE_URL`, `BETTER_AUTH_SECRET`, `CONFIG_ENC_KEY`, AI provider keys, `SEARXNG_SECRET`, or any other app secret can leak to the child process.

### Timeout + output cap

- Default timeout: `EXEC_TIMEOUT_MS` (default 60 000 ms) — kills the **process group** (`SIGKILL` to `-pid`) on expiry.
- Pre-spawn abort guard: if the `AbortSignal` is already aborted, returns immediately without spawning.
- Output cap: 64 KB each for stdout and stderr; overflow is truncated with `\n…[output truncated]`.
- `ExecResult` carries `{ exitCode, stdout, stderr, timedOut, aborted, mode }`.

### Dev escape hatch

`EXEC_UNCONFINED=1` (only honoured when `NODE_ENV !== 'production'`) lets the runner execute without privilege drop in local dev — jail and stripped env still apply. The runner logs a loud warning when this mode is active. Never set in production.

## The `exec` tool

`server/lib/agent/tools/exec.ts`:
- `kind: 'destructive'`, `dangerous: true`
- Schema: `{ command: string, cwd?: string }`
- `describeApproval` returns `{ tool: 'exec', command, proposedPattern: proposedPattern(command) }`
- On `ExecDisabledError` (misconfigured or jail violation), the error is returned as a model-visible result (`{ disabled: true, error }`) rather than thrown, so the model can inform Tony rather than producing a system error

## Approval prompt UI

`app/components/agent/ApprovalPrompt.vue` renders inline in the transcript panel when `voice.pendingApproval` is set:
- Shows the tool name and exact command in a monospace block
- "Always allow commands matching" checkbox + editable pattern field (pre-filled with `proposedPattern`, editable before saving)
- Approve / Deny buttons; emits `approve({ remember, pattern })` or `deny`

`useVoice.ts` exposes `pendingApproval` (ref), `sendApproval(requestId, approved, opts?)`, and `setProfile(profile)`. The client handles `approval` frames by setting `pendingApproval`; `approval-resolved` clears it.

## Activity logging

Every approval decision is logged to the activity log via `recordEvent`:
- `allowlisted`: command matched a persisted pattern, auto-approved
- `approve` / `deny`: Tony's explicit decision; includes the pattern if saved
- `timeout`: the 120 s window elapsed; includes the command

The exec tool's handler is wrapped in `withSpan` (tool span) in `buildAiTools`, so every execution is also a trace span in the activity log.

## Deployment

**Dockerfile**: the runtime stage installs `util-linux` (provides `setpriv`), creates the `agent` group/user (uid/gid 10001), creates `/workspace` owned by `agent`, and sets `EXEC_AGENT_UID`, `EXEC_AGENT_GID`, `EXEC_WORKSPACE_DIR` in the image environment.

**`docker-compose.prod.yml`**: a persistent `mymind-workspace` named volume is mounted at `/workspace` — the exec cwd-jail shared by the app container. This volume will also be used by B3 (file-edit/report rendering).

## Honest isolation statement

Exec is protected by: (a) the powerful-profile opt-in — normal conversations cannot reach exec; (b) the hard per-command approval gate — every call pauses until Tony approves; (c) a least-privilege `agent` user (uid 10001) with supplementary groups dropped via `setpriv --clear-groups`; (d) a `/workspace` cwd-jail (lexical path check + the uid boundary); (e) an allowlist-constructed stripped environment (no app secrets reach the child); and (f) the Docker container boundary.

It is **not** a true syscall sandbox. A compromised command running as the `agent` user could still read world-readable files inside the container and make outbound network calls. The gate, least-privilege user, and stripped secrets are the principal defenses; a stronger sandbox (bwrap/nsjail/gVisor) is a future hardening option if the Proxmox LXC ever supports nested namespaces.

## B3 / B4 forward

Cycle B3 (`gh` read, file-edit, report/visualization rendering) and B4 (ssh) ride this same harness — both will be `dangerous: true` tools that use `requestApproval` and the same `exec_approvals` allowlist infrastructure (with their own `tool` column values for pattern scoping). No architectural changes to the gate are needed.

## See also

- [agent.md](agent.md) — the agent surface, WS protocol, conversation store, Bridget personality
- [web-research.md](web-research.md) — `web_search` + `web_fetch` (Cycle B1, read-only tools, no gate)
- [ai-providers.md](ai-providers.md) — model registry
- [activity-log.md](activity-log.md) — observability (`withSpan`, `recordEvent`, the activity log surface)
