---
title: Credentialed, self-installing native exec — Cycle B3.2 (design)
status: design (approved 2026-06-20)
cycle: 35 (B3.2)
task: d1d7f0ab (Cycle B)
depends_on: B3.1 native systemd deploy (master) — exec now runs in LXC 114 but is fail-closed (`disabled`)
supersedes: B2's docker-sandbox exec model (setpriv→uid-10001 + /workspace jail + stripped env)
---

# Credentialed, self-installing native exec (Cycle B3.2)

## Goal
Turn the agent's `exec` tool back **on** as a credentialed, self-managing environment in LXC 114:
run real CLI tools (`gh` against private repos, `wrangler`, `neon`, `railway`, anything), inject
the user's service tokens so those tools "just work," and let the agent install its own utilities —
behind an **allowlist-first** approval gate and fully audited.

## Context / why
B3.1 re-platformed the app to a native systemd service (root) in LXC 114, retiring the Docker image
that provided B2's sandbox: the low-priv `agent` user (uid 10001), the `/workspace` jail, and
`EXEC_AGENT_UID`. As a result `selectExecMode` now returns `{mode:'disabled', reason:'no agent user
configured'}` and exec is fail-closed (every authed agent run that reaches exec gets
`ExecDisabledError`). B3.2 reworks exec for the native, **root-in-LXC** reality and adds the
credential + self-install layer. The user has explicitly accepted this posture — the LXC is the
security boundary; openclaw/hermes are cited prior art.

## Decisions (locked with the user)
| Decision | Choice | Rejected alternatives |
|---|---|---|
| Approval gate | **Allowlist-first** — known-safe runs silently, unknown prompts (+remember) | hard-gate (B2 nags every command); pure-autonomy+audit |
| Secret injection | **Always-on env** — all stored tokens in every command's env | bound-to-allowlist-entry; per-command opt-in |
| Privilege | **root in the (unprivileged) LXC**, no privilege drop, no jail | setpriv→low-priv user; per-command container |
| Internal reachability | **via exec + curl** (root has LAN); leave `web_fetch` SSRF guard intact | open `web_fetch` to homelab CIDRs |
| Exposure | **opt-in `powerful` profile** + global enable flag | on by default in Bridget |

## Design

### 1. Privilege model — `native-root`
`server/lib/exec/run.ts` `selectExecMode` gains a `native-root` mode. When the process is root
(`getuid()===0`) **and** exec is enabled (see §7), it returns `{mode:'native-root'}` and
`buildSpawnArgs` runs `/bin/sh -c <command>` directly as root (no `setpriv`). The docker `setuid`
path + `EXEC_AGENT_UID`/`EXEC_AGENT_GID` requirement are retired (kept only as an inert legacy
branch, or removed). `native-root` replaces `disabled` as the prod default once enabled; the
`EXEC_UNCONFINED` dev hatch folds into this. **This is the change that flips exec back on.**

### 2. No jail
Drop the `/workspace` cwd-jail enforcement in `resolveExecCwd` (the lexical + realpath escape
checks). Default cwd is a real, persisted working dir `/opt/mymind/workspace` (created by
`provision-native.sh`), but the agent may `cd` anywhere — it is root in its own box.

### 3. Credential store
- **Storage:** a new encrypted secrets store mirroring the `ai_config` pattern — reuse the existing
  config encryption (the `CONFIG_ENC_KEY`-derived key). Either a `settings` key (`exec_secrets`,
  JSON map of `name → encrypted value`) or a small dedicated table; implementer picks the closest
  match to `ai_config`. `server/lib/exec/secrets.ts` (new): `listSecretNames()`, `setSecret`,
  `deleteSecret`, `getDecryptedSecrets()` (server-only).
- **UI:** `/settings` → a **Secrets** tab — add/edit/delete named secrets (name + value; value is
  write-only, showing a last-4 hint like `api_tokens`). Suggested seeds: `GITHUB_TOKEN`,
  `CLOUDFLARE_API_TOKEN`, `NEON_API_KEY`, `RAILWAY_TOKEN` (free-form — any name).
- **Injection:** `buildExecEnv` changes from strip-all to **base allowlist (`PATH`/`HOME`/`LANG`)
  + every stored secret** decrypted and injected as an env var into every exec command.

### 4. Gate — allowlist-first + denylist
- Reuse `server/lib/exec/approvals.ts` (the `exec_approvals` store + chaining-safe anchored-glob
  matching). The decision flow in `tools/exec.ts` / `ai-tools.ts` changes: **before** prompting,
  match the command against the allowlist — matched ⇒ run silently; unmatched ⇒ the existing WS
  approval prompt, with optional remember-as-pattern.
- **Denylist** (`approvals.ts`, pure matcher, unit-tested) with two jobs:
  1. **Catastrophic hard-block** — never run, never approvable: `rm -rf /`, `rm -rf /*`, `mkfs*`,
     `dd of=/dev/*`, fork-bomb `:(){ :|:& };:`, etc.
  2. **Outbound-breadth rule** — refuse to *remember* an over-broad outbound pattern (`curl *`,
     `wget *`). Raw outbound with args is never blanket-allowlisted; only a **narrow scoped**
     pattern can be remembered (e.g. `curl http://192.168.2.25:8004/*`). This is the exfil tripwire
     that the always-on-env choice requires — a single broad `curl` can't silently ship every token.
- **Fail-closed:** an unmatched command with no connected approval channel auto-denies (unchanged
  from B2).

### 5. Self-install persistence
`apt`/`npm -g`/`pip` installs land in the LXC root filesystem and **persist** across app restarts
and CD deploys (the deploy sync only rewrites `/opt/mymind`'s tracked tree, not system packages).
First use is gated (the `apt`/`npm`/`pip` command is unmatched ⇒ prompt ⇒ remember a scoped
pattern). Caveat to document: a full LXC rebuild loses self-installed tools — they are not captured
in `provision-native.sh` (acceptable; rebuilds are rare and can be re-installed on demand).

### 6. Internal reachability (the rig probe)
exec runs as root with full LAN access, so `curl http://192.168.2.25:8004/v1/models` works — gated
by the allowlist. Because §4 keeps raw outbound out of broad allowlisting, the first internal curl
**prompts**, and the human approves+remembers a **narrow** pattern (`curl http://192.168.2.25:8004/*`),
after which internal probes run silently. `web_fetch`'s SSRF guard (`server/utils/net.ts`,
`isPrivateAddress`) stays intact — that tool ingests *untrusted external* content and must stay
paranoid; exec is the trusted-operator path for internal hosts.

### 7. Exposure + global enable
- `execTool` stays in the **`powerful` profile only** (`server/lib/agent/profile.ts`); default
  Bridget has no exec. `dangerous:true` semantics remain; the allowlist-first gate only changes
  *when* it prompts.
- A **global kill-switch** `settings.exec_enabled` (default **false**). Exec runs only when
  `exec_enabled === true` AND the active profile includes `execTool` AND `selectExecMode` returns
  `native-root`. Flipping `exec_enabled` off disables exec instantly without a deploy.

### 8. Audit
- The exec `tool` span is already recorded (`ai-tools.ts` `withSpan({kind:'tool', …})` →
  `activity_log` → `/activity`). Enrich its `meta`/`response` with: full command, exit code, mode,
  duration, **injected secret names** (not values), and the gate decision (allowlisted / approved /
  denied).
- Harden `server/lib/observability/redact.ts` (`sanitizeRequest`/`sanitizeResponse`) to **mask any
  stored secret value** appearing in a command string or its output — defense-in-depth so a token
  echoed by a command can never persist in a log row.

## Components / files
- `server/lib/exec/run.ts` — `native-root` mode; `buildSpawnArgs` native-root; `buildExecEnv` inject
  secrets; relax `resolveExecCwd`.
- `server/lib/exec/approvals.ts` — allowlist-first decision + denylist matcher (catastrophic
  hard-block + outbound-breadth rule).
- `server/lib/exec/secrets.ts` *(new)* — encrypted secrets store (reuse config crypto).
- `server/lib/agent/tools/exec.ts` — wire allowlist-first; enrich the result payload.
- `server/lib/agent/ai-tools.ts` — exec span enrichment.
- `server/lib/agent/profile.ts` — `powerful` profile (exists) + `exec_enabled` gating.
- `server/lib/observability/redact.ts` — mask secret values.
- `app/pages/settings.vue` (+ a settings component) — Secrets tab + `exec_enabled` toggle.
- DB — secrets store (settings key or new table) + `exec_enabled` setting; migration only if a new
  table is added.
- `deploy/provision-native.sh` — ensure `/opt/mymind/workspace` exists (already created in B3.1).
- Tests — `selectExecMode` native-root; denylist matcher (catastrophic + outbound-breadth);
  allowlist-first decision; secret-value redaction; secrets-store crypto roundtrip.

## Security posture (accepted)
root-in-LXC + always-on secrets + no jail, accepted by the user (LXC is the boundary;
openclaw/hermes prior art). Retained mitigations: the allowlist-first **human gate**, the
**outbound-breadth rule** (no `curl *`), the **catastrophic hard-block**, full **audit + value
redaction**, **opt-in profile + global kill-switch**, and unchanged app auth fronting everything
(exec is reachable only through an authenticated agent run, never anonymously).

## Out of scope (later cycles)
- B3.3 / B4: artifact/report rendering; `ssh`/`pct` to **other** homelab hosts (higher privilege).
- Per-secret scoping bound to allowlist entries (the injection option not chosen) — revisit only if
  always-on proves too broad in practice.
- Per-command containerization/sandboxing.

## Testing & validation
- **Unit:** the pure helpers above (mode select, denylist, allowlist-first decision, redaction,
  crypto roundtrip).
- **Live E2E (on the box, post-deploy):** enable `exec_enabled` + powerful profile; agent runs `gh`
  against a private repo (token from the store) → success; agent curls the rig
  `http://192.168.2.25:8004/v1/models`, approve+remember the scoped pattern → success; confirm
  `activity_log` shows both commands with secret values **redacted**; confirm a broad `curl *`
  remember is **refused**; confirm flipping `exec_enabled` off disables exec.
