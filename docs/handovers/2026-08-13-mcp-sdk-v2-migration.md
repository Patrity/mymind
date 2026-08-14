---
title: MCP SDK v2 migration — dual-era serving on the 2026-07-28 protocol (cycle 54)
cycle: 54
date: 2026-08-13
status: >
  ✅ SHIPPED. Merged to `master` fast-forward on 2026-08-13 (`00355c7..bce3d9f`, 9 commits — 5
  code, 4 docs), pushed, and deployed by CD run **31764558377** (test ✅ / deploy ✅). Prod
  verified after cutover: `/api/health` 200, unauthenticated `POST /api/mcp` 401 carrying the
  RFC 9728 `resource_metadata` pointer, and — the acceptance test that actually matters — two
  real authenticated MCP tool calls (`search_tasks`, `search_memories`) from a live **legacy-era**
  client (a Claude Code session's own `mymind` connection) succeeded against the migrated server,
  exercising auth, the new Host/Origin guards, the h3 bridge, the module-scoped handler, and the
  DB. Tasks 1-4 each review-clean (one fix round on Task 4); final whole-branch review returned
  "Merge with fixes" (3 doc corrections + 1 free one-liner), all applied and re-reviewed clean.
  Gates at HEAD before merge: **typecheck 0 errors / test 1118 passed across 145 files / build
  clean (65.9 MB, 19.6 MB gzip)**. No migration, no schema change, no persisted state.
branch: feat/mcp-sdk-v2 — merged fast-forward into master at bce3d9f
spec: ../superpowers/specs/2026-08-13-mcp-sdk-v2-migration-design.md
plan: ../superpowers/plans/2026-08-13-mcp-sdk-v2-migration.md
docs:
  - ../wiki/mcp.md (Endpoint section rewritten for v2, protocol-era table, authInfo omission,
    DNS-rebinding section incl. the Host/Origin split, h3 stream-cancel note) — mirrored to MyMind
  - ../superpowers/plans/00-roadmap.md (cycle 54 row)
task: 3e3c06b5 (MyMind)
---

# MCP SDK v2 migration (cycle 54)

Moved `POST /api/mcp` off the frozen `@modelcontextprotocol/sdk` v1 onto `@modelcontextprotocol/server`
v2, serving **both** protocol eras from the one endpoint. The success criterion was that no connected
agent could tell it happened — and after cutover, none could.

## Why this cycle existed

`@modelcontextprotocol/sdk@1.30.0` (2026-07-27) is the final v1 release and will never speak the
`2026-07-28` revision. v2 is a repackaging, not a version bump: `@modelcontextprotocol/sdk` splits into
`@modelcontextprotocol/server` + `@modelcontextprotocol/client`.

**This was a readiness cycle, not a feature cycle, and the docs should keep saying so.** The v2 *client*
still defaults to the 2025 `initialize` handshake and only probes when its host opts into
`versionNegotiation: { mode: 'auto' }`. Anthropic's announcement says modern-era support is "rolling out
across Claude products soon" with no dates. So nothing observable was gained on the day — what was gained
is that the day Claude Code or claude.ai flips, MyMind already works.

## What shipped

| Commit | What |
|---|---|
| `c661401` | SDK swap; `registerTool`; module-scoped `createMcpHandler`; h3 bridge |
| `dab2a6e` | First transport-level tests (4), both eras |
| `40e08eb` | DNS-rebinding guards + 6 tests |
| `299e81f`, `9ed6b89` | Wiki + roadmap; stale `server.tool()` signature fix |
| `f3f092d`, `a44676d` | `[::1]`; three doc-accuracy corrections |
| `bce3d9f` | Host/Origin allow-list split; Anthropic origins |

**Registration** — `server.tool(name, desc, shape, handler)` → `server.registerTool(name, { description, inputSchema }, handler)`.
`tool.schema` is passed **bare**: `registerTool` carries a `ZodRawShape` overload alongside the
`StandardSchemaWithJSON` one. `AgentTool.schema` is shared with the OpenAI/agent tool path and was not
touched.

**Route** — `readBody(event)` → `toWebRequest(event)` → Host/Origin guard → `mcpHandler.fetch(request, { parsedBody: body })`,
returning a web `Response` h3 sends directly. The `event._handled` dance is gone.

**Lifecycle inversion worth knowing:** `createMcpHandler` is built **once at module scope** (it owns a
subscription bus and a `close()`), where v1 built a server *and* a transport per request. Per-request
isolation is preserved — the *factory* runs per request, so every request still gets a fresh `McpServer`.

**Era policy** — `legacy` is **omitted**, selecting the `'stateless'` default, so 2025-era clients (i.e.
every Claude client today) are served alongside 2026-07-28 ones. **Never pass `legacy: 'reject'`** — it
would sever every existing connector.

**`authInfo` is deliberately not forwarded.** `AuthInfo` requires `{ token, clientId, scopes }`;
`ClientContext` is `{ type?, userId?, tokenId? }` and no variant matches. No tool handler reads auth
context, and v1 forwarded none either — omitting it keeps behaviour identical.

## Three spec errors that spiking caught before implementation

The spec was written from the published docs. Installing the real 2.0.0 packages and driving them
falsified three claims — all corrected in the spec before the plan was written:

1. **Nitro 2.13.4 runs h3 1.15.11, not h3 v2.** The `h3@2.0.1-rc.20` in the pnpm store belongs to a
   different consumer and never reaches the server runtime. The spec had claimed h3 v2 and a "direct"
   bridge. Real answer: `toWebRequest` + `parsedBody`, spiked end-to-end against real h3 before planning.
2. **`registerTool` takes a bare `ZodRawShape`.** The designed `z.object(...)` wrapper was unnecessary.
3. **`authInfo` cannot carry `event.context.client`.** Different shapes; the spec had said it would be
   forwarded.

**The lesson to carry:** the spec's stated "main unknown" (the h3 bridge) was retired *before* task 1 by
a 30-line spike. Every subsequent task built on verified ground.

## A false claim the final review caught — do not reintroduce it

The spec said "the v1 transport did offer this [Host/Origin validation]", which degraded into
**"restored"** in the wiki, the roadmap, and commit `40e08eb`'s message. The final reviewer pulled
v1.30.0's `webStandardStreamableHttp.js`: `enableDnsRebindingProtection` defaults to `false` and
validation is skipped entirely when false, and the pre-branch route passed only
`{ sessionIdGenerator: undefined }`.

**So `/api/mcp` had no Host or Origin validation before this branch.** These guards are **net-new
hardening**, not a restoration. Corrected in `docs/wiki/mcp.md`, the roadmap row, and
`server/lib/mcp/guards.ts`'s docstring. Commit `40e08eb`'s subject line is still wrong and was left
alone rather than rewriting history — **the commit log lies here; the wiki is right.**

This matters beyond pedantry: it means a brand-new gate went to production having never seen real traffic.

## The Host/Origin split (`bce3d9f`) — the subtlety that nearly bit

The new Origin check 403s any request whose `Origin` host isn't ours. Claude Code sends no `Origin` and
is unaffected, but the **claude.ai OAuth connector** (cycle 48) plausibly does. Tony chose to allow-list
Anthropic's origins pre-emptively rather than deploy and find out.

The naive fix — adding `claude.ai` to the single shared list — would also have accepted
**`Host: claude.ai`**, reopening the exact DNS-rebinding hole the guard exists to close, because `Host`
is precisely what a rebinding attacker controls. So the lists now differ **by design**:

- `mcpAllowedHosts(betterAuthUrl?)` — configured hostname + `localhost` + `127.0.0.1` + `[::1]`. Narrow.
- `mcpAllowedOrigins(betterAuthUrl?)` — the above **plus** `claude.ai`, `www.claude.ai`, `claude.com`,
  `www.claude.com`. Built *on top of* `mcpAllowedHosts` so the shared base can't drift.

The load-bearing test asserts **`Host: claude.ai` still returns 403**. Do not merge these lists.

Both fail closed: an unset/malformed `betterAuthUrl` yields loopback-only, and an empty allow-list makes
the SDK's `.includes()` deny everything.

## Testing

Before this cycle the tool registry was tested and **the wire never was**. Now:

- `test/mcp-transport.test.ts` (4) — real HTTP round-trips on **both** eras. `tools/list` runs against the
  real registry (no DB); `tools/call` against a synthetic one-tool server, deliberately, so `pnpm test`
  gains no Postgres dependency (CI has none and `deploy` needs `test`).
  **Each leg asserts `getProtocolEra()`** — without that, a modern client silently falling back to legacy
  would pass every other assertion. Proven red-then-green during implementation.
- `test/mcp-host-guard.test.ts` (12) — guards called **directly, not over HTTP**: Node's `fetch` treats
  `Host` as a forbidden header and silently strips it, so an over-HTTP "bad host" test never reaches the
  guard and returns a misleading `406` from content negotiation. A first spike hit exactly that trap.

Independent verification during review: all **38 tool schemas** were dumped and compared byte-for-byte
against `z.toJSONSchema(z.object(tool.schema))` — `properties` and `required` identical for every tool,
including all-optional schemas, enums, arrays, and `z.record`. The `inputSchema` cast is not flattening
anything. Nine request shapes (empty body, malformed JSON under two content-types, non-JSON-RPC, GET,
DELETE, bad/good Host, both eras) were probed against real h3: **nothing 500s that previously didn't**.

## Follow-ups (none merge-blocking)

1. **Verify the claude.ai connector live.** The origins are allow-listed but the connector has still never
   been exercised against the guard. Reconnect it and watch `server/plugins/observe-requests.ts` for
   `/api/mcp` 403s.
2. **`server/api/mcp/index.post.ts` has no automated coverage.** `mount()` in the transport test omits
   `parsedBody`, so it exercises the SDK's own body-reading path, not production's. Reviewer executed the
   production path by hand across nine shapes and found no live failure mode — what's missing is
   *regression* coverage. Fix: rebuild `mount()` on real h3 (`createApp` + `createRouter` +
   `toNodeListener`), ~15 lines, and the route becomes tested code.
3. **The `inputSchema` cast binds to a deprecated overload.** `NonNullable<Parameters<typeof server.registerTool>[1]>['inputSchema']`
   resolves to the SDK's *last* overload, which is marked `@deprecated ("Wrap with z.object({...}) instead")`.
   Shipped output is provably identical, and if a future SDK drops that overload the failure mode is a
   failed typecheck, not a broken schema. Worth hoisting to a named local and pinning explicitly.
   ⚠️ Note the plan's implementer-note #2 ("wrapping forks the shape shared with the agent path") is
   **wrong** — `z.object()` derives a new schema at call time and cannot mutate `tool.schema`. It also
   typechecks with no cast at all. Don't let that note mislead a future migration.
4. **h3 1.15.11's `sendStream` never cancels a web `ReadableStream` on client disconnect** (the `pipeTo`
   branch has no abort path; the Node-stream branch does). A modern-era `subscriptions/listen` stream whose
   client vanishes would orphan its bus subscription + keepalive interval; after `maxSubscriptions` (1024)
   further calls return `-32603`. **Unreachable today** (no modern-era clients, route auth-gated) but it is
   the one place the module-scoped handler can accumulate state. Documented in the wiki.
5. **Deferred protocol features** — cacheable list results (`ttlMs`/`cacheScope`, plausibly useful for our
   38-tool `tools/list`) and the Tasks extension. Kept out so a failed round-trip couldn't be ambiguous
   between transport and feature.
6. **The DCR → CIMD OAuth track.** `2026-07-28` shifts client registration from RFC 7591 to Client ID
   Metadata Documents and requires RFC 9207 issuer validation. MyMind's connector is DCR-based. This is the
   one piece of the release with real forward risk, it is independent of the SDK swap, and it only becomes
   load-bearing when claude.ai's connector moves to the modern era. **Its own cycle.**

## Operational notes for the next deploy

**The obvious smoke test is blind to this branch's worst failure mode.** If `betterAuthUrl` is empty in the
prod process, `mcpAllowedHosts` fails closed to loopback-only and *every* real request 403s — the "second
brain vanishes from every session" outcome. `/api/health` 200 and an unauthenticated `POST /api/mcp` 401
would **both still pass**, because health is a public prefix and the 401 comes from auth middleware before
the guard ever runs. Only a **real authenticated client call** detects it. That is why this cycle's
acceptance was two live MCP tool calls, and it is what any future MCP deploy should use.

Rollback would have been trivial and still is: revert the code commits and redeploy. No migration, no
schema change, no persisted state.

## Process notes

- A Task 1 subagent ran an unscoped `pkill -f "nuxt.mjs dev"` and killed an **unrelated project's** dev
  server (`neo4nls`). Every later dispatch carried an explicit "target exact PIDs, verify the command line,
  never unscoped `pkill`" constraint and all complied. Worth keeping in future dispatch prompts.
- Also note a stopped `pnpm dev` may leave the real `nuxt.mjs dev` child alive — killing the `pnpm` wrapper
  PID alone is not enough.
- Dev-server verification must **read the log for the actual port**: 3000 is often taken by another project
  and Nuxt silently picks 3001. A Task-1 check that appeared to pass on 3000 was only reaching the right app
  because the `pkill` above had freed that port.
