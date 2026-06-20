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
| Internal reachability | **via exec + curl** — LAN/private targets always-allowed (no prompt), external targets per-hostname allowlist; `web_fetch` SSRF guard untouched | open `web_fetch` to homelab CIDRs |
| Exposure | **opt-in `powerful` profile** + a per-session **cookie** enable toggle (default off) | on by default in Bridget; DB global flag |

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
- **Denylist** (`approvals.ts`, pure matcher, unit-tested): **catastrophic hard-block** — never run,
  never approvable: `rm -rf /`, `rm -rf /*`, `mkfs*`, `dd of=/dev/*`, fork-bomb `:(){ :|:& };:`, etc.
- **Outbound policy** (the exfil control the always-on-env choice requires) — a pure classifier in
  `approvals.ts` that extracts the target host(s) from outbound commands (`curl`/`wget` URLs + host
  args) and applies:
  - **LAN / private targets → always allowed, no prompt.** If every outbound target is a private
    address (reuse `isPrivateAddress` from `server/utils/net.ts`: loopback, `10/8`, `172.16/12`,
    `192.168/16`), the command runs silently. The agent freely reaches the rig and other homelab
    hosts — internal access is trusted.
  - **External targets → per-hostname allowlist.** A command targeting a public host needs a
    per-host allowlist entry; the first request to a new external host **prompts**, and
    approve+remember binds to that hostname/domain (`api.github.com`, not `curl *`). No broad
    outbound is ever remembered — exfiltration to an attacker host always requires an explicit,
    per-domain human approval.
  - Classification rule: a **literal private IP → LAN**; a public IP **or a hostname → external**
    (per-host allowlist). Hostnames that happen to resolve to the LAN are treated as external
    (approve once per host) — this avoids DNS-resolution-at-gate complexity and is fine because
    homelab access here is IP-addressed.
- **Fail-closed:** a gated command with no connected approval channel auto-denies (unchanged from B2).

### 5. Self-install persistence
`apt`/`npm -g`/`pip` installs land in the LXC root filesystem and **persist** across app restarts
and CD deploys (the deploy sync only rewrites `/opt/mymind`'s tracked tree, not system packages).
First use is gated (the `apt`/`npm`/`pip` command is unmatched ⇒ prompt ⇒ remember a scoped
pattern). Caveat to document: a full LXC rebuild loses self-installed tools — they are not captured
in `provision-native.sh` (acceptable; rebuilds are rare and can be re-installed on demand).

### 6. Internal reachability (the rig probe)
exec runs as root with full LAN access, and the §4 outbound policy treats **LAN/private targets as
always-allowed**, so `curl http://192.168.2.25:8004/v1/models` runs with **no prompt** — the rig
probe and any other homelab host work out of the box. `web_fetch`'s SSRF guard (`server/utils/net.ts`,
`isPrivateAddress`) stays intact — that tool ingests *untrusted external* content and must stay
paranoid; exec is the trusted-operator path for internal hosts. (Both the SSRF guard and the §4
outbound classifier share the same `isPrivateAddress` helper — one source of truth for "what is LAN".)

### 7. Exposure + enable toggle
- `execTool` stays in the **`powerful` profile only** (`server/lib/agent/profile.ts`); default
  Bridget has no exec. `dangerous:true` semantics remain; the allowlist-first gate only changes
  *when* it prompts.
- **Enable toggle = a cookie**, persisted the way the app's other frontend settings are: a
  `useCookie<boolean>('agent-exec-enabled', { default: () => false })` in the agent UI
  (`app/pages/agent/index.vue`, alongside the existing `agent-canvas` / `agent-speak` cookies). The
  server reads it at agent-run time via `getCookie(event, 'agent-exec-enabled')` (the same
  client-cookie→`getCookie` pattern already used for `clip_device`) and threads the boolean into the
  exec gate.
- Exec runs only when **all** hold: the cookie is on (this session), the active profile includes
  `execTool`, and `selectExecMode` returns `native-root`. Flipping the cookie off disables exec
  instantly, no deploy. **Background/cron agent runs carry no request cookie → exec is off** — a safe
  default (autonomous, unattended runs don't get a credentialed shell). The opt-in `powerful` profile
  remains the deliberate server-side capability grant; the cookie is the per-session "armed" switch.

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
- `server/lib/exec/approvals.ts` — allowlist-first decision + catastrophic denylist + the outbound
  classifier (LAN-allow / external per-host; reuses `isPrivateAddress` from `server/utils/net.ts`).
- `server/lib/exec/secrets.ts` *(new)* — encrypted secrets store (reuse config crypto).
- `server/lib/agent/tools/exec.ts` — wire allowlist-first + outbound policy; enrich the result payload.
- `server/lib/agent/ai-tools.ts` — exec span enrichment.
- `server/lib/agent/run.ts` + the agent-run request handler — thread the
  `getCookie(event, 'agent-exec-enabled')` boolean from the request into the agent run → exec gate.
- `server/lib/agent/profile.ts` — `powerful` profile (exists); exec gated by the threaded cookie flag.
- `server/lib/observability/redact.ts` — mask secret values.
- `app/pages/agent/index.vue` — `useCookie<boolean>('agent-exec-enabled')` toggle (next to
  `agent-canvas`/`agent-speak`); `app/pages/settings.vue` (+ component) — **Secrets** tab.
- DB — secrets store (settings key or new table; mirror `ai_config`); migration only if a new table
  is added. **No `exec_enabled` DB setting** — the toggle is the cookie.
- `deploy/provision-native.sh` — ensure `/opt/mymind/workspace` exists (already created in B3.1).
- Tests — `selectExecMode` native-root; catastrophic denylist matcher; outbound classifier
  (LAN-allow vs external per-host); allowlist-first decision; secret-value redaction; secrets-store
  crypto roundtrip.

## Security posture (accepted)
root-in-LXC + always-on secrets + no jail, accepted by the user (LXC is the boundary;
openclaw/hermes prior art). Retained mitigations: the allowlist-first **human gate**; the **outbound
policy** (LAN/private always-allowed, but every external host is per-domain allowlisted — so token
exfiltration to an attacker host always needs an explicit human approval); the **catastrophic
hard-block**; full **audit + secret-value redaction**; **opt-in `powerful` profile + a per-session
cookie toggle** (off by default, and off for unattended/cron runs); and unchanged app auth fronting
everything (exec is reachable only through an authenticated agent run, never anonymously).

## Out of scope (later cycles)
- B3.3 / B4: artifact/report rendering; `ssh`/`pct` to **other** homelab hosts (higher privilege).
- Per-secret scoping bound to allowlist entries (the injection option not chosen) — revisit only if
  always-on proves too broad in practice.
- Per-command containerization/sandboxing.

## Testing & validation
- **Unit:** the pure helpers above (native-root mode select, catastrophic denylist, outbound
  classifier [LAN vs external host extraction], allowlist-first decision, secret-value redaction,
  secrets-store crypto roundtrip).
- **Live E2E (on the box, post-deploy):** turn on the `agent-exec-enabled` cookie + powerful profile;
  agent runs `gh` against a private repo (token from the store) → success; agent curls the rig
  `http://192.168.2.25:8004/v1/models` → success with **no prompt** (LAN always-allowed); a request to
  a **new external host** prompts and binds per-hostname on approve+remember; confirm `activity_log`
  shows the commands with secret values **redacted**; confirm flipping the cookie off disables exec;
  confirm an unattended/cron agent run cannot exec (no cookie).
