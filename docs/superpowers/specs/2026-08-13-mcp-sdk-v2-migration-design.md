---
title: MCP SDK v2 migration — dual-era serving on the 2026-07-28 protocol
cycle: 54
date: 2026-08-13
status: spec — approved in brainstorm, not yet planned
tasks: 3e3c06b5
related:
  - ../../handovers/2026-08-08-mcp-doc-tool-ergonomics.md (cycle 53 — last change to server.ts)
  - ../../handovers/2026-07-17-mcp-oauth-connector.md (cycle 48 — the DCR connector this spec does NOT touch)
  - ../../wiki/mcp.md (current behaviour — describes the v1 transport this replaces)
---

# MCP SDK v2 migration

MCP shipped a new protocol revision, **2026-07-28**, and with it a new TypeScript SDK. This cycle
moves MyMind's MCP server onto that SDK while remaining fully compatible with the 2025-era clients
that are, today, the only clients that exist in practice.

This is deliberately a **plumbing cycle**. Nothing about the tool surface changes, and if the
migration succeeds no connected agent can tell it happened.

## Why now, and why only this much

The upstream release is larger than what we are adopting. `2026-07-28` brings a stateless protocol
core, header-based routing, Multi Round-Trip Requests, cacheable list results, an extensions
framework (Tasks, MCP Apps), and hardened authorization. We are adopting **the SDK**, not the
feature surface.

Three facts set that scope:

**1. The v1 SDK is now frozen.** `@modelcontextprotocol/sdk@1.30.0` (2026-07-27) is the final v1
release — maintenance only, and it will never speak `2026-07-28`. We are on `^1.29.0`. v2 is not a
version bump but a repackaging: `@modelcontextprotocol/sdk` splits into
`@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both at `2.0.0`. Staying put
means the gap only widens.

**2. Nothing observable is gained today.** The v2 *client* still defaults to the 2025 `initialize`
handshake and performs no era probe unless a host opts into `versionNegotiation: { mode: 'auto' }`.
Anthropic's announcement says modern-era support is "rolling out across Claude products soon" with
no dates attached. So the honest framing of this cycle is *readiness*, not benefit — the day Claude
Code or claude.ai flips, we already work.

**3. Our exposure is unusually small, and shrinking it further is not possible.** The entire MCP
surface is two files and 66 lines. We register **tools only** — no sampling, roots, or logging,
which are precisely the three surfaces `2026-07-28` deprecates (SEP-2577, 12-month window). Our
deprecation exposure is zero. The headline feature, the stateless core, we already have:
`server/api/mcp/index.post.ts:15` passes `sessionIdGenerator: undefined` and builds a fresh server
per request.

That combination — frozen dependency, no deadline, no feature need, tiny blast radius — is what
makes a small migration now preferable to a larger forced one later.

## Non-goals

**The OAuth track.** `2026-07-28` shifts client registration from Dynamic Client Registration
(RFC 7591) to Client ID Metadata Documents, and requires RFC 9207 issuer validation. MyMind's
connector is DCR-based — that is why the Client ID/Secret fields are left blank when adding it to
Claude. This is the one genuinely forward-looking risk in the release, but it is **independent of
the SDK swap**, lives in `server/middleware/auth.ts`, `server/utils/oauth-metadata.ts` and the
`.well-known` routes, and only becomes load-bearing when claude.ai's connector moves to the modern
era. It gets its own cycle.

**New protocol features.** Cacheable list results (`ttlMs`/`cacheScope`) would plausibly help — our
`tools/list` returns 38 tools on every connection — and the Tasks extension is interesting for the
enrichment work. Both are deferred. Adopting them in the same change as the transport swap would
mean a failed round-trip could not be attributed to one or the other.

**Known pre-existing MCP defects.** `edit_document` returning oversized results, and tool schemas
not advertising some server-side parameters, are both real and both out of scope here.

## Current state

```
server/api/mcp/index.post.ts   28 lines   route + transport
server/lib/mcp/server.ts       38 lines   factory + preamble + tool registration
```

The route reads the body with `readBody` (so h3 does not leave the stream half-consumed), constructs
a `StreamableHTTPServerTransport`, connects a freshly built `McpServer`, hands the raw Node
`req`/`res` to `transport.handleRequest`, and sets `event._handled = true` so the framework does not
write a second response.

`buildMcpServer()` iterates the shared `agentTools` registry, skips anything marked `dangerous`, and
calls `server.tool(name, description, schema, handler)` — the v1 API, already deprecated within v1.

Two invariants are pinned by tests: `test/mcp-parity.test.ts` (MCP exposes exactly the
non-dangerous registry tools) and `test/mcp-dangerous.test.ts` (dangerous tools never reach the
gateless MCP surface). Both reach only `mcpToolNames()`. **Nothing in the suite exercises the
transport** — the wire has never been under test.

## Design

### The three changes

**`package.json`** — remove `@modelcontextprotocol/sdk`, add `@modelcontextprotocol/server@^2.0.0`
as a dependency and `@modelcontextprotocol/client@^2.0.0` as a **dev** dependency (used only by the
new round-trip test; nothing at runtime needs a client).

**`server/lib/mcp/server.ts`** — `buildMcpServer()` becomes the per-request factory that
`createMcpHandler` invokes, and tool registration moves to the v2 API:

```ts
server.registerTool(
  tool.name,
  { description: tool.description, inputSchema: tool.schema },
  handler
)
```

**Verified against the real package, not the docs prose:** `registerTool` carries a
`ZodRawShape` overload alongside the `StandardSchemaWithJSON` one, so `tool.schema` is passed
**bare** — no `z.object(...)` wrapper. A spike confirmed the generated JSON Schema is identical to
today's (`properties: {query, limit}`, `required: ['query']`). This is strictly simpler than
originally designed.

`mcpToolNames()` and `MCP_INSTRUCTIONS` stay **byte-identical**. That is a deliberate constraint,
not an accident of scope: it means both existing test files must pass without modification, which
turns them into a regression check on the migration rather than something rewritten alongside it.
`MCP_INSTRUCTIONS` in particular is pinned by a cycle-53 wording test and a ≤998-char budget.

**`server/api/mcp/index.post.ts`** — the transport plumbing is replaced by a bridge to the
handler's web-standard face:

```ts
const body = await readBody(event)
const request = toWebRequest(event)
return await mcpHandler.fetch(request, { parsedBody: body })
```

The `event._handled` assignment disappears, because we no longer write to the Node response
ourselves — h3 accepts a returned web `Response` directly.

**Corrected after probing the tree:** an earlier draft of this spec claimed the project runs h3 v2
and could bridge natively. It does not. Nitro 2.13.4's runtime resolves to **h3 1.15.11** (the
`h3@2.0.1-rc.20` present in the pnpm store belongs to a different consumer and never reaches the
server runtime), which is why the current code correctly uses `event.node.req` and `event._handled`.
h3 v1 does export `toWebRequest(event): Request`, and `parsedBody` exists on
`McpHandlerRequestOptions` for exactly this case — the body has already been consumed by `readBody`,
so the payload is supplied out-of-band rather than re-read from the stream. This is the same pattern
the SDK documents for Express's `req.body`.

**This path is spiked and working**, not assumed: an h3 1.15.11 app wired exactly as above served a
real `Client` over real HTTP, on both eras, with `tools/list` and `tools/call` succeeding. The
h3-bridge risk this spec originally flagged as its main unknown is therefore retired before
implementation begins.

### The handler is module-scoped, not per-request

`createMcpHandler` returns `{ fetch, close, notify, bus }` and owns a subscription bus, so it is
constructed **once at module scope**. This is a real inversion of the current design, where a new
`McpServer` *and* a new transport are built inside the request handler. Under v2 the handler is the
long-lived object and the *factory* is what runs per request — so per-request isolation of the
`McpServer` is preserved exactly, while the transport-level plumbing is created once.

### Era policy: dual, defaulting to legacy

`createMcpHandler` serves both protocol eras from one endpoint, controlled by its `legacy` option.
We take the default, `legacy: 'stateless'`, which accepts 2025-era traffic alongside 2026-era.

This is the decision the whole cycle rests on. Every Claude client today opens with the 2025
`initialize` handshake, and the v2 client will keep doing so until its host opts into probing. If we
passed `legacy: 'reject'` we would sever every existing connection — including the `mymind` MCP
server that Claude Code sessions rely on continuously — in exchange for nothing.

**Success for this cycle is that no connected agent can tell the migration happened.** The modern
era is proven by test, not by traffic.

### Auth layering is unchanged

`server/middleware/auth.ts` runs ahead of all `/api/**` routes and already handles both client
paths (`mm_` bearer tokens and OAuth access tokens), emitting the RFC 9728 challenge on the MCP
route specifically. None of that moves.

This layering is not merely convenient, it is what the SDK prescribes: the v2 handler derives no
auth from request headers at all. The SDK's own guidance is that auth settles before era — a `401`
never decides which era a connection is on, and the auth wall answers before the MCP layer ever sees
a `server/discover` probe. So the existing middleware stays exactly where it is.

**We do not pass `authInfo`, and that is deliberate.** An earlier draft said the route would forward
`event.context.client` as `authInfo`; the real type does not permit it. `AuthInfo` requires
`{ token: string, clientId: string, scopes: string[] }`, whereas `event.context.client` is
`{ type: 'api-token', tokenId }`. Populating it would mean inventing a `clientId` and a scope list
that nothing reads — MyMind's connector is deliberately single-operator and unscoped, and no tool
handler consumes auth context (handlers receive `(args, { signal })` only). The v1 code passed no
auth to the MCP layer either, so omitting it keeps behaviour **identical**, which is this cycle's
whole standard. If per-client scoping is ever wanted, that is the OAuth cycle's job, not this one.

### DNS-rebinding protection must be added, not inherited

The v2 handler performs **no** `Host` or `Origin` validation — the docs are explicit that on a
fetch-native runtime there is no app factory to arm it. The v1 transport did offer this. Migrating
without replacing it would be a silent security regression, so `hostHeaderValidationResponse` and
`originValidationResponse` (both from `@modelcontextprotocol/server`) go in front of `fetch`,
allow-listing the production host. A request with no `Origin` header always passes, so machine
clients are unaffected.

Behaviour confirmed by direct probe: a bad `Host` returns `403`, a bad `Origin` returns `403`, and
both a matching `Host` and an absent `Origin` pass. **Test these by calling the guard functions
directly, not over HTTP** — Node's `fetch` treats `Host` as a forbidden header and silently strips
it, so a round-trip "bad host" test never exercises the guard at all and reports an unrelated status
(a first spike attempt returned `406` from content negotiation, which would have been easy to
mistake for a passing guard).

### What must not change

`AgentTool.schema` is a `ZodRawShape` (`server/lib/agent/types.ts:39`) and is **shared** — the same
shape feeds the OpenAI tool-JSON-schema path used by the in-app agent. v2's `registerTool` wants a
`z.object(...)`, so the wrapping happens **at the MCP boundary only**, inside the registration loop.
Changing the registry's type to satisfy the new SDK would push a transport migration into the agent
runtime, which is how a 3-file change becomes a 40-file one.

## Testing

**The two existing MCP tests must pass unmodified.** If either needs an edit, the migration
overreached its boundary and that is the signal to stop.

**New: a transport round-trip test.** This closes a gap that predates the migration — today the
registry is tested and the wire is not. The test mounts the handler and performs a real
`tools/list` followed by one `tools/call`, twice:

- a **default (legacy-era) client**, which is what every Claude client is today — this is the
  compatibility proof
- a client with `versionNegotiation: { mode: 'auto' }`, which probes and lands on **modern** — this
  is the proof the migration achieved anything at all

Asserting `getProtocolEra()` on both is what distinguishes a genuine dual-era result from a test
that passes because everything quietly fell back to legacy. Without that assertion the modern case
proves nothing — a lesson this project has already paid for (see the cycle-52 CAS test that never
reached the CAS, and the `vacuous-tests-pass-without-reaching-code` memory).

**Gates:** `pnpm typecheck`, `pnpm test`, `pnpm build`, all clean.

**Live validation.** `playwright-cli` is the project default for web work but is the wrong
instrument here — there is no UI on this path. The real end-to-end proof is that a Claude Code
session's own `mymind` MCP connection is a live legacy-era client against prod: if `tools/list` and
a real tool call still succeed after deploy, legacy compatibility is proven against the actual
client that matters, not a simulated one.

## Risks

**~~The h3 → web `Request` bridge~~ — RETIRED before planning.** This was the spec's main unknown.
It was spiked against real h3 1.15.11 + `createMcpHandler` + a real `Client` over real HTTP, on both
eras, and works (see "The three changes"). The spike also corrected the version assumption this spec
was originally built on. What remains is integration inside Nitro specifically — the same bridge,
but with the auth middleware and Nitro's own body handling in front of it, which Task 1 verifies in
the running dev server before any other task starts.

**v2.0.0 is roughly two weeks old** (published 2026-07-27, after five alphas and five betas). It is
a `.0` of a repackaged SDK. That argues for the round-trip test being written early rather than as
cleanup, and against adopting any additional v2 feature in the same change.

**This server is load-bearing for every Claude Code session.** A regression does not degrade a
feature, it removes memory, docs, and task access from every future session — including the sessions
that would diagnose it. Deploy verification is therefore not optional, and the rollback path (revert
the three files; no migration, no schema change, no state) must stay clean. Note that this cycle
touches no database and no persisted state, which is what makes rollback genuinely trivial.

## Documentation

`docs/wiki/mcp.md` currently documents the v1 `StreamableHTTPServerTransport` and the
`event._handled` h3-v1 detail by name. It must be updated in the same change — the endpoint section
rewritten for `createMcpHandler`, the era policy stated explicitly, and the cycle bumped to 54 —
and then mirrored to MyMind.
