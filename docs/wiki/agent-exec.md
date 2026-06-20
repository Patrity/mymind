---
title: Agent Exec — Credentialed Native-Root Exec (Cycle B3.2)
status: shipped
cycle: 35 (B3.2)
updated: 2026-06-20
---

# Agent Exec — Credentialed Native-Root Exec (Cycle B3.2)

Cycles B2 and B3.1 added the approval gate harness and moved the app to a native systemd process (root in LXC 114). B3.2 reworks the exec runner for that reality: exec now runs **natively as root in the LXC** (no `setpriv`, no `agent` uid drop, no `/workspace` jail), always injects the user's service tokens, and applies an allowlist-first gate with a catastrophic hard-block. The LXC container is the security boundary.

## What must be true for exec to run

Exec is disabled by default. It runs only when **two operator-controlled gates** are open AND a **process-level prerequisite** is satisfied:

**Gate 1 — `powerful` profile** — `server/lib/agent/profile.ts` defines two profiles. `bridgetProfile` (default) includes `agentTools` only; `powerfulProfile` adds `execTool`. The model cannot call exec unless the active profile is `powerful`. Selected per-connection via `{ type: 'profile', profile: 'powerful' }` WS frame.

**Gate 2 — `agent-exec-enabled` cookie** — the `/agent` page exposes an "Exec enabled" toggle (`useCookie<boolean>('agent-exec-enabled', { default: () => false })`). Toggling it sends `{ type: 'execEnabled', value: true|false }` over the WS; `ConnState.execEnabled` carries the current state. At agent-run time, `effectiveTools` (`server/lib/agent/run.ts`) strips `execTool` from the profile's tool registry when `execEnabled === false`. The cookie is **off by default** and is **not present in background/cron/unattended agent runs** — those always run without exec.

**Prerequisite (fail-closed) — process running as root** — `runConstrained` calls `selectExecMode({ uid: process.getuid(), nodeEnv, unconfined })`. When the process is root (`uid === 0`), it returns `{ mode: 'native-root' }` and exec proceeds. In non-root dev, `EXEC_UNCONFINED=1` (with `NODE_ENV !== 'production'`) returns `{ mode: 'unconfined' }` (same runtime path, no privilege drop, stripped env still applies). Anything else returns `{ mode: 'disabled' }` and `ExecDisabledError` is thrown. This is not an operator-configured gate — it is a fail-closed check that prevents exec from silently working in an unexpected runtime context.

Flipping the cookie off disables exec immediately with no deploy.

## `runConstrained` — the exec runner

`server/lib/exec/run.ts`. Every exec goes through this function; it is fail-closed by design.

### Privilege model — `native-root`

`buildSpawnArgs` runs `/bin/sh -c <command>` directly — no `setpriv`, no uid/gid manipulation. The process is root in the LXC and that is the boundary. There is no `EXEC_AGENT_UID`/`EXEC_AGENT_GID` requirement; the B2 `setuid` mode and uid-10001 agent user are retired.

### Default cwd — `/opt/mymind/workspace`

`resolveExecCwd` resolves the working directory:
- Default (no `cwd` arg): `path.resolve(workspaceRoot)` where `workspaceRoot = process.env.EXEC_WORKSPACE_DIR ?? '/opt/mymind/workspace'`
- Relative `cwd`: resolved relative to `workspaceRoot` via `path.resolve(workspaceRoot, cwd)`
- Absolute `cwd`: used as-is

There is **no cwd jail** — absolute paths go straight through. The agent is root in its own LXC and may work in any directory.

`/opt/mymind/workspace` is created by `deploy/provision-native.sh` and persists across deploys.

### Secret injection — `buildExecEnv`

The child environment is **constructed from scratch** (allowlist-by-construction) with three base vars (`PATH`, `HOME` = workspace root, `LANG=C.UTF-8`), then every decrypted secret from the encrypted store is merged in. App secrets (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `CONFIG_ENC_KEY`, AI keys, etc.) are never in the child env — they are not passed and not in the env the secrets store builds from. Secret values that appear in command strings or output are **masked** in the result payload (see §Audit).

### Timeout + output cap

- Default timeout: `EXEC_TIMEOUT_MS` (default 60 000 ms) — kills the **process group** (`SIGKILL` to `-pid`) on expiry.
- Pre-spawn abort guard: if the `AbortSignal` is already aborted, returns immediately without spawning.
- Output cap: 64 KB each for stdout and stderr; overflow is truncated with `\n…[output truncated]`.
- `ExecResult` carries `{ exitCode, stdout, stderr, timedOut, aborted, mode }`.

## Credential store — `exec_secrets`

`server/lib/exec/secrets.ts`. Secrets are stored in the `settings` table under key `exec_secrets` as a JSON doc `{ version: 1, secrets: Record<name, encryptedBase64> }`, encrypted with the same key derivation as the AI config registry (`CONFIG_ENC_KEY` / `BETTER_AUTH_SECRET` via HKDF).

- Secret names must match `/^[A-Z_][A-Z0-9_]*$/` (valid env var names, shell-safe).
- `listSecretNames()` returns name + last-4 chars of the decrypted value (write-only display).
- `getDecryptedSecrets()` returns the full plaintext map (server-only, called at exec time).
- `setSecret(name, value)` / `deleteSecret(name)` upsert / drop entries.

**UI:** `/settings → Secrets` — add/edit/delete named secrets (value is write-only; shows last-4 hint). Suggested names: `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`, `RAILWAY_TOKEN` (free-form).

## Gate — allowlist-first + outbound policy + catastrophic hard-block

`server/lib/exec/approvals.ts` + `server/lib/exec/outbound.ts`.

### Catastrophic hard-block (`isCatastrophic`)

These commands are **refused unconditionally** — they can never be run even if the human approves:

| Pattern | What it catches |
|---|---|
| `rm -rf /` or `rm -rf /*` | root filesystem wipe (recursive + forced, target `/` or `/*`) |
| `mkfs*` | format a filesystem |
| `dd of=/dev/*` | overwrite a block device |
| `:(){ :|:& };:` | fork bomb |
| `shutdown` / `reboot` / `halt` / `poweroff` | system stop/restart |

This is a **two-layer defense**:

1. **Gate layer** — `execAutoApproveDecision` (`server/lib/exec/approvals.ts`) returns `{ allow: false, reason: 'catastrophic' }` for catastrophic commands. This means the gate does **not** auto-approve them; instead they fall through to the normal human-approval prompt (the same approval channel as any other unlisted command). A catastrophic command reaching this layer is treated like an unknown command — Tony is asked.

2. **Handler layer** — even if Tony approves, `tools/exec.ts` checks `isCatastrophic` again in the handler **before** calling `runConstrained`. It returns `{ blocked: true, error: 'refused: catastrophic command' }` to the model and never spawns the process. Approval cannot override this hard-block.

The result: catastrophic commands are always surfaced to the human (not silently auto-denied), but they can never actually execute regardless of the approval outcome.

### Outbound classifier (`classifyOutbound`)

For commands containing `curl` or `wget`, the classifier extracts target hosts from `https?://…` URLs and applies:

- **`lan`** — every extracted host is a dotted-decimal IPv4 that `isPrivateAddress` classifies as private (loopback, `10/8`, `172.16/12`, `192.168/16`). LAN/private commands are **always allowed, no prompt**.
- **`external`** — any hostname, or a public IP. Requires a per-host allowlist entry or an approval.
- **`none`** — no `curl`/`wget` found. Falls through to the pattern allowlist.

Hostname-addressed LAN targets (e.g. `http://nas.local`) are classified `external` (no DNS resolution at gate time) — approve once per host. This avoids DNS complexity and is acceptable since homelab hosts are reachable by IP.

### Allowlist-first decision (`execAutoApproveDecision`)

```
isCatastrophic?  → allow=false (prompt human; handler hard-blocks before spawning even if approved)
outbound = lan?  → allow silently
matchesApproval? → allow silently
else             → prompt (approval channel)
```

`matchesApproval(command, patterns)` uses anchored glob matching: `*` compiles to `[^;&|` + `` ` `` + `$()<>\n\r]*` — shell metacharacters that chain commands. Patterns are anchored `^…$` so a `git *` pattern can never match `git status && rm -rf /`. Bare `*` is rejected by `validatePattern`.

`proposedPattern(command)` derives the suggested allowlist entry: `<first-token> *`.

`approvalOutcome(event)` maps `approve`/`deny`/`timeout` to `{ approved, persist, pattern }`.

### Approval channel (unchanged from B2)

When `execAutoApproveDecision` returns `allow: false`, the gate prompts via the existing WS approval flow:
1. A `requestId` UUID is allocated, a deferred promise + 120 s timeout stored in `ConnState.pendingApprovals`, and an `{ type: 'approval', requestId, tool, command, proposedPattern }` frame is sent to the client.
2. The client renders `ApprovalPrompt.vue` in the transcript panel; Tony approves or denies (optionally saving the pattern to the allowlist).
3. An `{ type: 'approve', requestId, remember?, pattern? }` or `{ type: 'deny', requestId }` frame resolves the deferred.
4. **Fail-safe:** if no approval channel is present (headless/cron), the tool auto-denies.
5. On connection close or interrupt, all pending approvals are auto-denied.

### Allowlist management — `/settings → Agent Tools`

`GET/PUT/DELETE /api/settings/exec-approvals` — list, add/update, revoke patterns. The `exec_approvals` table (`id` uuid PK, `pattern` text, `tool` text default `exec`, `created_at`, `last_used_at`; unique on `(tool, pattern)`).

## The `exec` tool

`server/lib/agent/tools/exec.ts`:
- `kind: 'destructive'`, `dangerous: true`
- Schema: `{ command: string, cwd?: string }`
- `autoApprove` loads patterns from `exec_approvals` and calls `execAutoApproveDecision` — returns `true` (allow silently) or `false` (prompt). This replaces B2's always-prompt-for-dangerous-tool behaviour.
- `handler` on success: `getDecryptedSecrets()` → `runConstrained(command, { cwd, signal, secrets })` → mask secret values in `command`, `stdout`, `stderr` via `maskSecrets`. Returns `{ command (masked), exitCode, stdout (masked), stderr (masked), timedOut, aborted, mode, secretsInjected: [names] }`.
- `handler` on `ExecDisabledError`: returns `{ disabled: true, error }` — the model is informed, not a system error.
- `handler` on catastrophic: returns `{ blocked: true, error: 'refused: catastrophic command' }` before touching `runConstrained`.

## Audit + secret redaction

- Every exec tool call is wrapped in a `withSpan({ kind: 'tool', … })` span in `buildAiTools` → logged to `activity_log` → visible at `/activity`.
- `maskSecrets(text, values)` (`server/lib/observability/redact.ts`) replaces every stored secret value appearing in the command string or its stdout/stderr with `[REDACTED]` before the result is logged or returned to the model.
- The result payload includes `secretsInjected: [names]` (not values) for the audit trail.
- Approval decisions (`allowlisted`, `approve`, `deny`, `timeout`) are logged via `recordEvent`.

## WebSocket protocol additions (B2 + B3.2)

**Client → server:**
| Frame | Purpose |
|---|---|
| `{ type: 'profile', profile: 'bridget' \| 'powerful' }` | Switch profiles per-connection |
| `{ type: 'execEnabled', value: boolean }` | Toggle exec gate per-session (sent by the `agent-exec-enabled` cookie watcher) |
| `{ type: 'approve', requestId, remember?, pattern? }` | Approve a pending tool call |
| `{ type: 'deny', requestId }` | Deny a pending tool call |

**Server → client:**
| Frame | Purpose |
|---|---|
| `{ type: 'approval', requestId, tool, command, proposedPattern }` | Dangerous tool call needs approval |
| `{ type: 'approval-resolved', requestId }` | Pending approval timed out (120 s auto-deny) |

`approve`/`deny`/`execEnabled` frames are processed **immediately** (like `interrupt`) — not queued behind the turn lock.

## Self-install persistence

`apt`, `npm -g`, `pip` installs land in the LXC root filesystem and persist across app restarts and CD deploys (the deploy sync only overwrites `/opt/mymind`'s tracked tree). First use of an install command is unmatched → prompts → approve+remember to add a scoped pattern. **Caveat:** a full LXC rebuild loses self-installed tools; they can be re-installed on demand.

## Honest security posture (B3.2)

Exec is protected by:
- **(a) opt-in `powerful` profile** — the default Bridget conversation cannot reach exec.
- **(b) `agent-exec-enabled` cookie** — off by default; unattended/background runs carry no cookie and cannot exec.
- **(c) allowlist-first gate** — known-safe commands run silently; new/external commands pause for Tony's approval before anything is spawned.
- **(d) catastrophic hard-block** — a small set of irreversible commands can never run, even with approval.
- **(e) outbound policy** — LAN/private always-allowed, but every external host is per-domain allowlisted; token exfiltration to an attacker domain always needs an explicit per-domain human approval.
- **(f) stripped base environment + secret injection** — app secrets (`DATABASE_URL`, auth keys, etc.) are never in the child env; only the stored exec secrets are injected.
- **(g) audit + secret-value redaction** — every command, exit code, and injected secret names are logged; secret values that appear in output are masked before logging.
- **(h) the LXC container boundary** — the accepted isolation layer.

This is **not** a syscall sandbox. A command running as root in the LXC has full root access within that container. The gate, outbound policy, and audit are the principal defenses. Stronger sandboxing (bwrap/nsjail) is a future option.

## See also

- [agent.md](agent.md) — agent surface, WS protocol, conversation store, Bridget personality
- [web-research.md](web-research.md) — `web_search` + `web_fetch` (read-only tools, no gate)
- [ai-providers.md](ai-providers.md) — model registry
- [activity-log.md](activity-log.md) — observability (`withSpan`, `recordEvent`, the activity log surface)
