---
title: Multi-User MyMind — Feasibility Exploration
status: exploration (pre-brainstorm; no cycle committed)
updated: 2026-08-10
method: 11 parallel subsystem explorers + independent gap-hunting critic (12 agents, ~957k tokens, all claims file-cited; key counts re-verified by hand)
---

# Multi-User MyMind — Feasibility Exploration

**Question:** People are interested. What would it take — at a systems level — to let other users in? Is it feasible?

**Verdict: feasible, but it is not a feature — it is an authorization re-architecture.** The app's *architecture* is unusually favorable (clean layering, better-auth already multi-user-capable, a single services seam). The app's *data model and trust model* are purely single-user: **zero domain tables have an owner column, and "authenticated" means "owner of everything."** There are three viable paths, and the cheapest one requires almost no code.

---

## 1. Where it stands today (measured)

| Metric | Value |
|---|---|
| Domain tables referencing `user.id` | **0** (better-auth's own tables only; `clip_threads.user_id` exists but is nullable, FK-less, dead code) |
| Tables needing an owner column | **~20** (documents, memories, tasks, projects, sessions, messages, tool_events, images, conversations ×2, chunks, review_queue, memory_relations, graph_layout, agent_files, api_tokens, activity_log, exec_approvals, clip_*) |
| API handler files | 126 (~121 authenticated), 8 of which bypass the services layer |
| Service functions to thread ownership through | ~171 exported across 39 service files |
| `publishChange` emit sites to re-plumb | ~113 |
| Agent/MCP tools calling unscoped services | 38 |
| Background crons scanning global queues | 8 (+ observability flush loop, email digester) |
| Instance-global settings docs (incl. AI keys, exec secrets, persona) | 10, editable by **any** authenticated principal |
| Roles / admin concept | none (`user` has no role column; `requireSession` guards 3 of ~121 endpoints) |
| Rate limiting | none, anywhere |

The single-user assumption is *stated policy*, not accident: `server/utils/auth.ts:10-13` disables signup so the public can't "self-register into the shared corpus," and `docs/wiki/agent-exec.md:190` declares "root-in-LXC IS the boundary."

**Live risk today, zero users added:** if `ALLOW_SIGNUP=true` is ever left set on the internet-exposed deploy, any stranger who registers gets full read/write over the entire corpus, all settings, AI keys, exec secrets, and a root shell via the agent. The bootstrap flag is the whole wall.

## 2. Why it's *more* feasible than it looks

- **better-auth is already multi-user.** Sessions, accounts, OAuth-token→user binding (`oauth_access_token.user_id`), PKCE + consent — all N-user-ready. The MCP OAuth lane *already resolves a real `userId`* at the middleware (`server/middleware/auth.ts:50`)… which `buildMcpServer()` then discards (`server/api/mcp/index.post.ts:12`).
- **The enforcement seam exists.** Handlers are uniformly thin; nearly everything funnels through `server/services/`. Scoping is wide but *mechanical*: thread an `ownerId` through ~171 functions, backed by Postgres RLS as a safety net (8 handlers already bypass services; future ones will too).
- **Per-request statelessness where it matters.** The MCP server is built fresh per request (easy to bind a user); the live bus's own comment sketches the multi-user fix ("add a scope arg + topic filter"); storage funnels through one driver interface with no path-based serving.
- **The frontend is surprisingly clean.** No "Tony" hardcoded anywhere in `app/` (grep-clean); `auth.global.ts` is a pure session check; the API-keys settings page is already shaped as personal data. ("Tony" *is* hardcoded server-side: agent persona default, prompt, MCP instructions.)

## 3. The blockers, ranked

1. **No tenant column, no ownership predicate, anywhere.** Every list/get/search/update/delete across documents, memories, tasks, projects, sessions, images, conversations, activity, review, graph, search is table-wide. The whole rest of this list is downstream of this.
2. **`api_tokens` are userless skeleton keys** (`server/db/schema/api-tokens.ts:4-12`; middleware sets `{type:'api-token', tokenId}` with no `userId`, `auth.ts:32`). Every mm_ token — ShareX, cc-hook, MCP — is full-corpus access; token list/revoke is instance-global too.
3. **Agent exec = root RCE on the shared host.** `/bin/sh -c` as root (`User=root`, `deploy/mymind.service:8`), no cwd jail, **all decrypted service secrets injected into the child env**, and the system prompt maps the host and the DB-access command (`server/lib/agent/prompt.ts:72-79`). Allowlisted/LAN commands auto-run with no prompt. Incompatible with untrusted users; per-tenant sandboxing is a near-rewrite (XL) — the pragmatic v1 is exec **admin-only**.
4. **Skills are cross-user prompt injection.** One global namespace (`/projects/mymind/skills/`), and agent-authored skills go live immediately with only structural validation (`server/services/skills.ts:33-44`) — one user's skill becomes live instructions inside every other user's agent.
5. **No roles.** Any authenticated user (including any bearer token) can rewrite AI provider keys, exec secrets, the shared persona, exec-approval patterns, and fire `/api/admin/*` LLM-cost batch jobs (`images-backfill?all=1` re-enriches the entire fleet).
6. **All three SSE surfaces are global.** The change bus leaks ids/slugs/activity rhythm to every client; **clipboard SSE pushes full message DTOs to any subscriber with zero thread-ownership check** (`clipboard/threads/[id]/stream.get.ts`) — and the clipboard REST surface is equally unscoped; agent-activity SSE broadcasts tool summaries globally.
7. **`activity_log` persists raw model request/response payloads with no owner**, listed globally — one user's prompts and document content readable by all (`schema/activity-log.ts:22-24`).
8. **Account lifecycle is a bootstrap hack.** `ALLOW_SIGNUP` env toggle; no invites, no email verification, no password reset (Resend is wired only to error digests). There is no safe way to add a second account today.
9. **Global config singletons + zero metering.** One `ai_config` (operator's keys), one persona, one observability config; the `tokens` column in activity_log is never populated; no per-user cost attribution, budgets, quotas, or billing anywhere in the repo.
10. **Global uniqueness = cross-tenant collisions, writes, and oracles.** `documents.path` (two users can't both own `notes/inbox.md`; upsert-by-path writes into the other's doc), `sessions (source, external_id)` (**a hostile client can inject into another user's session row via colliding external_id** — integrity attack, which then poisons enrichment), `memories.content_hash` (write breaks + existence oracle), `projects.git_remote_key` (two tenants cloning the same repo merge into one project, cross-attaching sessions and memories).

### Cross-tenant *writes* people would miss (not just read leaks)

- The **memory relations judge** pools nearest-neighbors across owners, feeds their content into the LLM prompt, and **auto-supersede can archive another user's memory** (`server/services/memory-resolve.ts:141-173`).
- **Enrichment cross-pollination**: `enrich-input` injects *all* projects into its filing prompt (can file your doc into my project); the image tag library unions *everyone's* tags into auto-apply.
- **Session upsert collision** (above) lets one tenant silently rewrite another's transcript history.
- **Blob dedup** is a cross-tenant existence oracle (sha-addressed store confirms someone already uploaded a given file), and un-sharing an image doesn't revoke it (public, immutable, 1-year cache + slug reuse).

### Operational blockers for hosting anyone

No rate limiting; no per-user quotas (50MB/request, unbounded total, vision+embedding spend per upload); UMAP recompute is synchronous and event-loop-blocking, `POST /api/graph/recompute` is a free DoS button; crons have no locks (a second replica silently double-runs every job and doubles LLM spend); backups are a manual `pg_dump` recipe; monitoring emails itself from inside the process being monitored; `/api/agent/llm` trusts a spoofable XFF header behind manual proxy rules.

## 4. Subsystem scorecard

| Subsystem | Effort | Headline |
|---|---|---|
| DB schema & migrations | M | ~20 owner columns + composite uniques + backfill; drizzle already drifted on one index |
| Auth & identity | M | Core ready; needs token→user, roles, invites, verification, `requireUser` contract |
| HTTP API + services scoping | L | ~171 functions / 126 handlers; mechanical; RLS backstop strongly advised |
| MCP + hooks ingestion | L | `buildMcpServer(userId)`, stamp ingest from token, per-user project keying |
| Background workers | L | 8 crons → per-user slicing + fairness + budgets; locks for >1 replica |
| Live SSE + clipboard | M | Scope bus + fix clipboard's unscoped fat-payload surfaces |
| Storage & sharing | M | Ownership on 3 blob tables, quotas, GC/refcount decision; slug design survives |
| Search + galaxy | L | Owner-thread 7 search lanes + graph; per-user UMAP off the event loop |
| Frontend | M | User menu/sign-out (none exists!), role-gate 12 settings pages, split my- vs instance-settings, cache/cookie scoping |
| AI config + agent + exec | **XL** | Dominated by exec sandboxing; M–L if exec goes admin-only |
| Deploy & ops | L (invite-only) / XL (SaaS) | Rate limits, email, backups, monitoring; SaaS = re-platform |

## 5. Three paths

### Path 0 — Instance-per-user (days; recommended first move)
Don't multi-tenant the code; multiply the instances. Proxmox is already the substrate: clone an LXC (or compose stack) per person — own Postgres, own storage, own `ALLOW_SIGNUP` bootstrap, own subdomain via Pangolin. **The LXC boundary per-tenant-sandboxes exec by construction** — the exact property the shared codebase can't offer. Costs: ops toil (fleet upgrades — CD currently targets exactly one LXC), N× cron/embedding load on the shared AI rig, no shared anything. Perfect for validating whether interest survives contact with reality, at near-zero code cost and zero corpus risk.

### Path A — True multi-tenancy, invite-only (~6–8 cycles)
For trusted-but-real users on one instance. Cycle sketch, in dependency order:
1. **Identity & roles** — `api_tokens.user_id`, role column + `requireUser`/`requireAdmin`, `buildMcpServer(userId)`, hook ingest stamped from the presenting token, invite flow + email verification/reset via the existing Resend key.
2. **Tenancy migration** — owner columns on ~20 tables, composite uniques (`(user_id, path)`, `(user_id, content_hash)`, `(user_id, source, external_id)`, `(user_id, git_remote_key)`), backfill to the bootstrap user, FK/cascade cleanup for user deletion.
3. **Scoping** — thread ownership through services + the 8 direct-db handlers; **enable Postgres RLS as backstop**; ship a two-user isolation test harness (seed two users, assert zero cross-hits on *every* surface — search alone has 7 lanes).
4. **Async & live** — per-user cron slicing + fairness + budgets (populate that `tokens` column), `publishChange` carries `userId`, per-user galaxy with UMAP off-thread, `activity_log.user_id`, per-user review/memory badges.
5. **Frontend** — user menu/profile/sign-out, role-gated nav + settings split (my-settings vs instance-settings), onboarding rework (admin instance-setup vs user welcome), vue-query cache + cookie scoping per account.
6. **Ops hardening** — in-app rate limiting, per-user quotas, automated off-box backups + restore runbook, external uptime monitoring. **Exec + skills authoring: admin-only.**

### Path B — Hosted SaaS (a different product)
Everything in A, plus: leave the homelab (managed PG, S3, orchestration), metered AI + billing (nothing exists — grep finds zero payment references), exec either removed or per-tenant microVMs, multi-instance safety (broker-backed bus, distributed job locks), compliance (per-user export/delete — impossible today; blob refcounting), abuse/moderation for the public image host, real on-call. Only worth it if this becomes a business.

## 6. Decision forks (settle before any spec)

1. **AI keys:** operator-paid global registry with per-user budgets, or BYO-keys per user? The entire onboarding + settings IA forks on this.
2. **Exec:** admin-only (cheap, ships Path A) vs per-tenant sandbox (XL) vs removed for tenants.
3. **Blob store:** keep global dedup + add refcounted GC (accepting the existence oracle) vs per-user key prefixes (loses dedup).
4. **Enforcement depth:** service-arg threading alone vs + Postgres RLS. Recommendation: RLS — one missed WHERE clause anywhere is a silent corpus leak.
5. **Galaxy under tenancy:** per-user layouts (off-thread UMAP) now, or galaxy stays owner-only until it matters.

## 7. Recommendation

1. **Now:** Path 0 for the interested people. It's days of ops work, validates demand, and gives each person the same trusted-single-user product you actually built — including (their own) exec.
2. **Regardless of path, this month:** keep `ALLOW_SIGNUP` off; add `api_tokens.user_id` + a role column anyway (S effort — it closes the god-token and settings-takeover risks even for the single-user instance).
3. **If demand is real:** Path A behind invites, exec/skills admin-only, RLS on. Budget ~6–8 cycles.
4. **Path B** only with revenue intent — it is a re-platform, not an upgrade.

---

*Full per-subsystem findings (12 structured reports, file:line-cited) are archived in the session workflow journal; the ranked blockers above were independently corroborated by a critic agent that re-derived them from the repo without seeing the explorers' output.*
