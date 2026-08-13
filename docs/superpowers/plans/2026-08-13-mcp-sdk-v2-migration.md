# MCP SDK v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move MyMind's MCP server from the frozen `@modelcontextprotocol/sdk` v1 onto `@modelcontextprotocol/server` v2, serving both the 2025 and 2026-07-28 protocol eras from the existing `/api/mcp` endpoint, with no observable change for any current client.

**Architecture:** `createMcpHandler` is constructed **once at module scope** in the route file and owns the transport plumbing; the existing `buildMcpServer()` becomes the per-request factory it calls, so per-request `McpServer` isolation is preserved exactly. The route bridges h3 v1 → web standard via `toWebRequest(event)` and hands the already-read body across as `parsedBody`. Tool registration moves from `server.tool()` to `server.registerTool()`, passing the existing `ZodRawShape` bare.

**Tech Stack:** Nuxt 4 / Nitro 2.13.4 / h3 1.15.11, `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0 (dev only), Zod 4, Vitest.

## Global Constraints

- **`pnpm` only.** Never npm/yarn. Gates: `pnpm typecheck`, `pnpm test`, `pnpm build` — all must be clean.
- **`test/mcp-parity.test.ts` and `test/mcp-dangerous.test.ts` must pass UNMODIFIED.** If either needs an edit to go green, the change has exceeded its boundary — **stop and report**, do not adjust the test.
- **`MCP_INSTRUCTIONS` and `mcpToolNames()` stay byte-identical.** `MCP_INSTRUCTIONS` is pinned by a cycle-53 wording test and a ≤998-char budget.
- **Do not modify `server/lib/agent/tools.ts` or `server/lib/agent/types.ts`.** `AgentTool.schema` is a `ZodRawShape` shared with the OpenAI/agent tool path. The MCP boundary adapts to it, never the reverse.
- **No new Postgres dependency in `pnpm test`.** CI has no database service and `deploy` needs `test`. DB-backed tests live in `*.db.test.ts` (excluded from the CI gate). Nothing in this plan may require a live DB.
- **`legacy` posture is `'stateless'`** — the default, achieved by omitting the option. Never pass `legacy: 'reject'`.
- **Do not pass `authInfo`.** `AuthInfo` requires `{ token, clientId, scopes }`; `event.context.client` is `{ type, tokenId }`. v1 passed no auth to the MCP layer, and no tool handler consumes it. Omitting keeps behaviour identical.
- **Auth stays in `server/middleware/auth.ts`.** Do not move, duplicate, or bypass it.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Drop `@modelcontextprotocol/sdk`; add `@modelcontextprotocol/server` (dep) + `@modelcontextprotocol/client` (devDep) |
| `server/lib/mcp/server.ts` | Modify | Per-request `McpServer` factory + preamble + `registerTool` loop |
| `server/lib/mcp/guards.ts` | Create | Pure host allow-list (testable without Nitro auto-imports) |
| `server/api/mcp/index.post.ts` | Modify | Module-scoped handler, h3→web bridge, Host/Origin guards |
| `test/mcp-transport.test.ts` | Create | Dual-era round-trip over real HTTP (the wire, currently untested) |
| `test/mcp-host-guard.test.ts` | Create | Direct unit tests of the DNS-rebinding guards |
| `docs/wiki/mcp.md` | Modify | Current-behaviour reference: endpoint, era policy, cycle bump |
| `docs/superpowers/plans/00-roadmap.md` | Modify | Cycle 54 row |

**Reference material:** the design spec is `docs/superpowers/specs/2026-08-13-mcp-sdk-v2-migration-design.md`. Every API shape below was verified against the installed 2.0.0 packages by spike before this plan was written — treat the signatures as authoritative.

---

### Task 1: Swap the SDK and migrate registration + route

**Files:**
- Modify: `package.json`
- Modify: `server/lib/mcp/server.ts:1` (import), `server/lib/mcp/server.ts:27-38` (`buildMcpServer`)
- Modify: `server/api/mcp/index.post.ts` (whole file, 28 lines)
- Test: `test/mcp-parity.test.ts`, `test/mcp-dangerous.test.ts` (existing — run, do not edit)

**Interfaces:**
- Consumes: `agentTools` from `server/lib/agent/tools` (unchanged), `AgentTool.schema: ZodRawShape`
- Produces:
  - `buildMcpServer(): McpServer` — unchanged signature, now returns a v2 `McpServer`
  - `mcpToolNames(): string[]` — unchanged
  - `MCP_INSTRUCTIONS: string` — unchanged
  - Task 2 imports `buildMcpServer` and `mcpToolNames`; Task 3 imports nothing from here

- [ ] **Step 1: Branch, then swap the dependencies**

Do not build this on `master`. Note the branch name — Task 5 merges it.

```bash
git checkout -b feat/mcp-sdk-v2
pnpm remove @modelcontextprotocol/sdk
pnpm add @modelcontextprotocol/server@^2.0.0
pnpm add -D @modelcontextprotocol/client@^2.0.0
```

⚠️ If other Claude Code sessions are running in this working directory, a checkout here moves
`HEAD` for all of them (see the `parallel-sessions-share-git-head` memory). Use a git worktree if
that is a risk.

- [ ] **Step 2: Confirm nothing else imports the old package**

Run: `grep -rn "@modelcontextprotocol/sdk" --include="*.ts" --include="*.vue" --include="*.json" . | grep -v node_modules | grep -v pnpm-lock`

Expected: no output. If any file other than the two in this task appears, **stop and report** — the migration surface is larger than this plan assumes.

- [ ] **Step 3: Update the import in `server/lib/mcp/server.ts`**

Replace line 1:

```ts
import { McpServer } from '@modelcontextprotocol/server'
```

Leave line 2 (`import { agentTools } from '../agent/tools'`), `mcpToolNames`, `MCP_INSTRUCTIONS`, and the block comment above `buildMcpServer` exactly as they are.

- [ ] **Step 4: Migrate the registration loop**

Replace the body of `buildMcpServer` (currently `server/lib/mcp/server.ts:27-38`) with:

```ts
export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS })
  for (const tool of agentTools) {
    if (tool.dangerous) continue // MCP has no approval channel — never expose a gated tool here
    // `tool.schema` is a bare ZodRawShape and is passed as-is: registerTool carries a ZodRawShape
    // overload alongside the StandardSchema one, so no z.object() wrapper is needed (and adding one
    // would fork the shape shared with the OpenAI/agent tool path).
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args: Record<string, unknown>) => {
      const ac = new AbortController()
      const exec = await tool.handler(args, { signal: ac.signal })
      return { content: [{ type: 'text' as const, text: JSON.stringify(exec.result) }] }
    })
  }
  return server
}
```

- [ ] **Step 5: Rewrite the route**

Replace the entire contents of `server/api/mcp/index.post.ts` with:

```ts
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildMcpServer } from '../../lib/mcp/server'

// Created ONCE, at module scope. Unlike the v1 transport, this handler is a long-lived object
// (it owns a subscription bus and a close() lifecycle). Per-request isolation still holds: the
// factory below runs per request, so every request still gets its own fresh McpServer.
//
// `legacy` is deliberately omitted, which selects the 'stateless' default: 2025-era clients (every
// Claude client today) are served alongside 2026-07-28 clients from this one endpoint. Passing
// 'reject' here would sever every existing connector.
const mcpHandler = createMcpHandler(() => buildMcpServer())

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts (runs before all /api/** routes).
  // That middleware accepts both Bearer tokens and sessions, so if we reach this point
  // event.context.client is set and the caller is authenticated. We deliberately do NOT forward
  // it as `authInfo`: AuthInfo wants { token, clientId, scopes }, no tool handler reads auth, and
  // v1 passed none either — inventing a shape here would be a behaviour change, not a migration.

  // readBody consumes and caches the body, so the Request built below carries no readable stream.
  // `parsedBody` is the SDK's supported channel for exactly that case (same as Express req.body).
  const body = await readBody(event)
  const request = toWebRequest(event)

  return await mcpHandler.fetch(request, { parsedBody: body })
})
```

Note: `defineEventHandler`, `readBody`, and `toWebRequest` are all Nitro auto-imports (Nitro registers every lowercase `h3` export except `use`), matching the file's existing style — do not add explicit `h3` imports.

- [ ] **Step 6: Run the existing MCP tests — they must pass unmodified**

Run: `pnpm vitest run test/mcp-parity.test.ts test/mcp-dangerous.test.ts`
Expected: PASS, all assertions. **If either fails, fix the source, never the test.**

- [ ] **Step 7: Run the full gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: typecheck 0 errors; full suite green; build clean.

- [ ] **Step 8: Prove it in the running dev server**

This is the step that catches what unit tests cannot — Nitro's own body handling and the auth middleware in front of the bridge.

```bash
pnpm dev   # leave running in a second shell
```

Mint or reuse an `mm_` API token from `/settings/api-keys`, then:

```bash
TOKEN=mm_xxx   # replace with a real token
curl -s -X POST http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}' | head -40
```

Expected: a JSON-RPC result (SSE-framed) containing `serverInfo.name: "mymind"` and the `instructions` preamble. A `401` means the token is wrong; a `406` means the `Accept` header is missing.

Then confirm the unauthenticated path still challenges correctly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/mcp
```

Expected: `401`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-lock.yaml server/lib/mcp/server.ts server/api/mcp/index.post.ts
git commit -m "feat(mcp): migrate to SDK v2 with dual-era serving

createMcpHandler replaces StreamableHTTPServerTransport, serving both the
2025 and 2026-07-28 eras from /api/mcp (legacy:'stateless' default). The
handler is module-scoped; buildMcpServer stays the per-request factory.

registerTool takes the existing ZodRawShape bare — no z.object wrapper, so
the schema shared with the OpenAI/agent path is untouched."
```

---

### Task 2: Dual-era transport round-trip test

Closes a gap that predates this migration: the registry has always been tested, the wire never has.

**Files:**
- Create: `test/mcp-transport.test.ts`

**Interfaces:**
- Consumes: `buildMcpServer()`, `mcpToolNames()`, `MCP_INSTRUCTIONS` from `server/lib/mcp/server`; `createMcpHandler` from `@modelcontextprotocol/server`; `Client`, `StreamableHTTPClientTransport` from `@modelcontextprotocol/client`
- Produces: nothing consumed by later tasks

**Why it is built this way:** `tools/list` exercises the real registry with no database (schemas only). A real `tools/call` would hit Postgres, which `pnpm test` has no access to — so the call leg runs against a synthetic one-tool server, proving the *call path over the wire* without inventing a CI database dependency. Real tool calls against real data are proven in Task 5, against prod, where it actually means something.

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp-transport.test.ts
// The MCP WIRE, not the registry: proves createMcpHandler serves both protocol eras from one
// endpoint. Deliberately DB-free so it runs in `pnpm test` (CI has no Postgres) — see the plan.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { buildMcpServer, mcpToolNames, MCP_INSTRUCTIONS } from '../server/lib/mcp/server'

// Mirrors server/api/mcp/index.post.ts: web Request in, web Response out.
function mount(handler: { fetch: (r: Request) => Promise<Response> }) {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      // @ts-expect-error duplex is required by undici for a streaming body but is not in the DOM types
      duplex: 'half'
    })
    const response = await handler.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
  })
}

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, () => r((s.address() as { port: number }).port)))

// Each era gets its own connect options. `undefined` is the DEFAULT client posture — the 2025
// initialize handshake, which is what every Claude client does today.
const ERAS = [
  { label: 'legacy', expected: 'legacy', opts: {} },
  { label: 'modern', expected: 'modern', opts: { versionNegotiation: { mode: 'auto' as const } } }
]

describe('MCP transport — dual-era serving', () => {
  const realHandler = createMcpHandler(() => buildMcpServer())
  let server: Server
  let port: number

  beforeAll(async () => {
    server = mount(realHandler)
    port = await listen(server)
  })

  afterAll(async () => {
    await realHandler.close()
    server.close()
  })

  for (const era of ERAS) {
    it(`serves the real registry to a ${era.label}-era client`, async () => {
      const client = new Client({ name: 'test', version: '1.0.0' }, era.opts)
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`)))

      // The assertion that makes this test non-vacuous: without it, a modern client that silently
      // fell back to legacy would still pass every other assertion below.
      expect(client.getProtocolEra()).toBe(era.expected)

      const list = await client.listTools()
      expect(list.tools.map(t => t.name).sort()).toEqual(mcpToolNames().sort())

      // The preamble is the first text every connecting agent reads — prove it survives the wire.
      expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS)

      // Proves the ZodRawShape actually became a real JSON Schema over the wire, not an empty
      // object. Cast because the Tool type models inputSchema loosely.
      const searchMemories = list.tools.find(t => t.name === 'search_memories')
      const schema = searchMemories?.inputSchema as { properties?: Record<string, unknown>, required?: string[] }
      expect(Object.keys(schema?.properties ?? {})).toContain('query')
      expect(schema?.required ?? []).toContain('query')

      await client.close()
    })
  }
})

describe('MCP transport — tools/call over both eras', () => {
  // A synthetic registry: the real tools reach Postgres, which `pnpm test` has no access to.
  // This proves the CALL path over the wire; registry correctness is covered by mcp-parity.
  const handler = createMcpHandler(({ era }) => {
    const server = new McpServer({ name: 'probe', version: '1.0.0' })
    server.registerTool('echo', { description: 'Echo', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ text, era }) }] }))
    return server
  })
  let server: Server
  let port: number

  beforeAll(async () => {
    server = mount(handler)
    port = await listen(server)
  })

  afterAll(async () => {
    await handler.close()
    server.close()
  })

  for (const era of ERAS) {
    it(`round-trips a tool call on the ${era.label} era`, async () => {
      const client = new Client({ name: 'test', version: '1.0.0' }, era.opts)
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`)))
      expect(client.getProtocolEra()).toBe(era.expected)

      const res = await client.callTool({ name: 'echo', arguments: { text: 'navmesh' } })
      const content = res.content as Array<{ type: string, text: string }>
      // The handler stamps the era it actually served, so this proves the call ran on the era the
      // client negotiated — not merely that some call succeeded.
      expect(JSON.parse(content[0].text)).toEqual({ text: 'navmesh', era: era.expected })

      await client.close()
    })
  }
})
```

- [ ] **Step 2: Run it and watch it pass, then prove it can fail**

Run: `pnpm vitest run test/mcp-transport.test.ts`
Expected: PASS (4 tests).

A test that has never been red proves nothing. Temporarily break the era negotiation to confirm the test is actually reaching it — in `test/mcp-transport.test.ts`, change the `modern` entry's `opts` to `{}`:

Run: `pnpm vitest run test/mcp-transport.test.ts`
Expected: **FAIL** with `expected 'legacy' to be 'modern'` on both modern cases.

**Revert that change** and re-run to confirm PASS (4 tests).

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: green, with 4 more tests than before this task.

- [ ] **Step 4: Commit**

```bash
git add test/mcp-transport.test.ts
git commit -m "test(mcp): cover the wire, both protocol eras

Nothing in the suite has ever exercised the MCP transport, only the tool
registry. Round-trips tools/list against the real registry and tools/call
against a synthetic server (DB-free, so it stays in the CI gate).

Asserts getProtocolEra() on both legs: without it a modern client that
silently fell back to legacy would pass every other assertion."
```

---

### Task 3: DNS-rebinding guards

The v1 transport offered Host/Origin validation; `createMcpHandler` performs **none**. Migrating without replacing it would be a silent security regression.

**Files:**
- Create: `server/lib/mcp/guards.ts`
- Modify: `server/api/mcp/index.post.ts`
- Create: `test/mcp-host-guard.test.ts`

**Interfaces:**
- Consumes: `hostHeaderValidationResponse`, `originValidationResponse` from `@modelcontextprotocol/server`
- Produces: `mcpAllowedHosts(betterAuthUrl?: string): string[]` from `server/lib/mcp/guards.ts`

**Why the helper is its own module, not part of the route:** route files under `server/api/**` rely
on Nitro auto-imports (`defineEventHandler`, `readBody`, `toWebRequest`, `useRuntimeConfig`), which
do not exist under vitest — importing one from a test fails at import time. So the allow-list lives
in a plain module and takes the config value as a **parameter** rather than reading
`useRuntimeConfig()` itself. This mirrors the existing pattern in `server/utils/oauth-metadata.ts`,
where `oauthOrigin(...)` is passed `useRuntimeConfig().betterAuthUrl` by its caller.

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp-host-guard.test.ts
// DNS-rebinding guards. These call the guard functions DIRECTLY rather than over HTTP on purpose:
// Node's fetch treats `Host` as a forbidden header and silently strips it, so a round-trip
// "bad host" test never reaches the guard and reports an unrelated status (406 from content
// negotiation) that looks deceptively like a pass.
import { describe, it, expect } from 'vitest'
import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { mcpAllowedHosts } from '../server/lib/mcp/guards'

const req = (headers: Record<string, string>) =>
  new Request('http://brain.costanzoclan.com/api/mcp', { method: 'POST', headers })

describe('MCP DNS-rebinding guards', () => {
  const allowed = mcpAllowedHosts('https://brain.costanzoclan.com')

  it('falls back to localhost-only when no URL is configured', () => {
    // Fail closed: an unset config must not silently allow every Host.
    expect(mcpAllowedHosts(undefined)).toEqual(['localhost', '127.0.0.1'])
  })

  it('allows the production host', () => {
    expect(hostHeaderValidationResponse(req({ host: 'brain.costanzoclan.com' }), allowed)).toBeUndefined()
  })

  it('allows localhost for dev', () => {
    expect(hostHeaderValidationResponse(req({ host: 'localhost:3000' }), allowed)).toBeUndefined()
  })

  it('rejects an unknown Host with 403', () => {
    expect(hostHeaderValidationResponse(req({ host: 'evil.example.com' }), allowed)?.status).toBe(403)
  })

  it('rejects a cross-site Origin with 403', () => {
    const r = req({ host: 'brain.costanzoclan.com', origin: 'https://evil.example.com' })
    expect(originValidationResponse(r, allowed)?.status).toBe(403)
  })

  it('allows a request with no Origin — machine clients never send one', () => {
    expect(originValidationResponse(req({ host: 'brain.costanzoclan.com' }), allowed)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/mcp-host-guard.test.ts`
Expected: FAIL — cannot resolve `../server/lib/mcp/guards`.

- [ ] **Step 3: Create the guard module**

Create `server/lib/mcp/guards.ts`:

```ts
/**
 * Hosts the MCP endpoint will answer on.
 *
 * `createMcpHandler` performs NO Host/Origin validation of its own (the v1 transport did), so
 * without this a DNS-rebinding attacker could reach /api/mcp from a victim's browser.
 *
 * Takes the configured URL as a PARAMETER rather than reading useRuntimeConfig() itself: this
 * module is imported by tests, where Nitro's auto-imports do not exist. Mirrors how
 * server/utils/oauth-metadata.ts takes `betterAuthUrl` from its caller.
 *
 * Returns hostnames only — the SDK's validators are port-agnostic.
 */
export function mcpAllowedHosts(betterAuthUrl?: string): string[] {
  const local = ['localhost', '127.0.0.1']
  if (!betterAuthUrl) return local // fail closed: never allow every Host when unconfigured
  try {
    return [new URL(betterAuthUrl).hostname, ...local]
  } catch {
    return local
  }
}
```

- [ ] **Step 4: Wire the guards into the route**

In `server/api/mcp/index.post.ts`, extend the imports:

```ts
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { buildMcpServer } from '../../lib/mcp/server'
import { mcpAllowedHosts } from '../../lib/mcp/guards'
```

Then, inside the handler, immediately after `const request = toWebRequest(event)`:

```ts
  // A request with no Origin always passes both helpers, so machine clients are unaffected.
  const allowed = mcpAllowedHosts(useRuntimeConfig().betterAuthUrl as string | undefined)
  const rejected = hostHeaderValidationResponse(request, allowed)
    ?? originValidationResponse(request, allowed)
  if (rejected) return rejected
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/mcp-host-guard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Confirm the dev server still serves**

With `pnpm dev` running, re-run the authenticated `initialize` curl from Task 1 Step 8.
Expected: same successful result — `localhost` is on the allow-list.

This step is not optional: it is the only check that the guard does not reject legitimate traffic.
A guard that rejects everything would still pass every unit test in Step 1.

- [ ] **Step 7: Run the full gates**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add server/lib/mcp/guards.ts server/api/mcp/index.post.ts test/mcp-host-guard.test.ts
git commit -m "fix(mcp): restore DNS-rebinding protection under SDK v2

createMcpHandler does no Host/Origin validation where the v1 transport did,
so the migration would have dropped it silently. Guards run before fetch;
a request with no Origin still passes, so machine clients are unaffected.

Tests call the guards directly — Node's fetch strips the forbidden Host
header, so an over-HTTP test never reaches the guard at all."
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/wiki/mcp.md` (frontmatter + the `## Endpoint` section)
- Modify: `docs/superpowers/plans/00-roadmap.md` (append a cycle 54 row)

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–3
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Update the wiki frontmatter**

In `docs/wiki/mcp.md`, set `cycle: 54` and `updated: 2026-08-13`. Leave `status: shipped` and `title: MCP Server`.

- [ ] **Step 2: Replace the `## Endpoint` section**

The current text names `@modelcontextprotocol/sdk`, `StreamableHTTPServerTransport`, and the `event._handled` h3-v1 detail — all now false. Replace that section with:

```markdown
## Endpoint
`POST /api/mcp` — `@modelcontextprotocol/server` v2 `createMcpHandler`, serving **both protocol
eras** from this one endpoint.

The handler is built **once at module scope** (it owns a subscription bus and a `close()`
lifecycle); `buildMcpServer()` is the factory it calls **per request**, so every request still gets
a fresh `McpServer` with no shared state. Wired into the Nitro h3 handler
(`server/api/mcp/index.post.ts`): `readBody(event)` → `toWebRequest(event)` →
`mcpHandler.fetch(request, { parsedBody })`, returning a web `Response` that h3 sends directly.
The body is passed as `parsedBody` because `readBody` has already consumed the stream.

### Protocol eras
| | 2025 era (`legacy`) | 2026-07-28 era (`modern`) |
|---|---|---|
| Revisions | `2024-10-07` … `2025-11-25` | `2026-07-28` |
| Handshake | `initialize` | `server/discover` probe |
| Served? | **Yes** — `legacy: 'stateless'` (the default, by omitting the option) | Yes |

Every Claude client today opens with the 2025 `initialize` handshake — the v2 *client* only probes
when its host opts into `versionNegotiation: { mode: 'auto' }` — so in practice all live traffic is
`legacy`. Both eras are proven by `test/mcp-transport.test.ts`, which asserts `getProtocolEra()` on
each leg. **Never pass `legacy: 'reject'`:** it would sever every existing connector.

`authInfo` is deliberately not forwarded to the handler. `AuthInfo` requires
`{ token, clientId, scopes }` while `event.context.client` is `{ type, tokenId }`, no tool handler
reads auth context, and the connector is intentionally single-operator. Authorization is enforced
entirely by `server/middleware/auth.ts`, ahead of this route.

### DNS-rebinding protection
`createMcpHandler` performs **no** Host/Origin validation (the v1 transport did), so
`hostHeaderValidationResponse` / `originValidationResponse` run before `fetch`, allow-listing the
configured host plus `localhost`/`127.0.0.1`. A request with no `Origin` passes, so machine clients
are unaffected. Note when testing: Node's `fetch` silently strips the forbidden `Host` header, so
guard tests must call the helpers directly rather than over HTTP.
```

- [ ] **Step 3: Add the roadmap row**

Append a row to the cycle table in `docs/superpowers/plans/00-roadmap.md`, following the existing column format (`| 54 | **Title** — summary | status | [spec](...) | [plan](...) | [handover](...) |`). Summarise: SDK v1→v2 migration, dual-era serving, `registerTool` with bare `ZodRawShape`, module-scoped handler, restored DNS-rebinding guards, first transport-level tests. Mark status `✅ shipped` only once Task 5 has verified prod; until then use `🚧 built, not deployed`.

- [ ] **Step 4: Mirror the wiki page to MyMind**

Per CLAUDE.md, wiki pages are mirrored. Use the `mymind` MCP `sync_document` tool with the local file `docs/wiki/mcp.md`, targeting the existing mirrored page. Do not create a duplicate — search first (`search_docs` for "MCP Server wiki") and sync to the existing path if one exists.

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/mcp.md docs/superpowers/plans/00-roadmap.md
git commit -m "docs(mcp): document v2 dual-era serving

The wiki described the v1 transport and the event._handled h3-v1 detail by
name; both are now false. Adds the era table, the authInfo omission and its
reason, and the Host-header testing gotcha."
```

---

### Task 5: Ship and verify in production

**Files:** none (deploy + verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–4
- Produces: the handover, and the roadmap status flip

**Why this task exists:** this server is load-bearing for every Claude Code session. A regression removes memory, docs, and task access from every future session — including the session that would diagnose it. The rollback path is clean (three files, no migration, no schema, no persisted state), but it has to be *known* clean before merging.

- [ ] **Step 1: Final whole-branch review**

Per this project's cycle convention, run a whole-branch review before merge. Confirm specifically:
- `test/mcp-parity.test.ts` and `test/mcp-dangerous.test.ts` are **unmodified** (`git diff master --stat -- test/mcp-parity.test.ts test/mcp-dangerous.test.ts` → empty)
- `MCP_INSTRUCTIONS` is unchanged (`git diff master -- server/lib/mcp/server.ts | grep '^[-+].*MyMind is Tony'` → empty)
- `server/lib/agent/tools.ts` and `server/lib/agent/types.ts` are untouched

- [ ] **Step 2: Confirm gates one final time**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all clean. Record the test count for the handover.

- [ ] **Step 3: Merge and push**

```bash
git checkout master && git merge --ff-only feat/mcp-sdk-v2 && git push
```

Then watch the CD run to green (`gh run watch`).

- [ ] **Step 4: Verify prod**

```bash
curl -s -o /dev/null -w 'health:%{http_code}\n' https://brain.costanzoclan.com/api/health
curl -s -o /dev/null -w 'mcp-unauth:%{http_code}\n' -X POST https://brain.costanzoclan.com/api/mcp
```

Expected: `health:200`, `mcp-unauth:401`.

- [ ] **Step 5: Prove a real client still works — the actual acceptance test**

Reconnect this session's own `mymind` MCP server (or start a fresh Claude Code session) and run a real tool call against prod, e.g. `search_tasks` or `search_memories`. This is a live **legacy-era** client against the migrated server, exercising the auth middleware, the h3 bridge, the factory, and a real DB-backed tool.

Expected: results return normally. **If this fails, roll back immediately** — `git revert` the three code commits and redeploy; there is no migration or state to unwind.

- [ ] **Step 6: Write the handover**

Create `docs/handovers/2026-08-13-mcp-sdk-v2-migration.md` with accurate frontmatter (title, cycle 54, date, status, related spec/plan links). Record: what shipped, the three spec corrections found by spiking (h3 v1 not v2; `ZodRawShape` needs no `z.object`; `authInfo` not forwardable), the gate numbers, the prod verification evidence, and what was explicitly deferred (the DCR→CIMD OAuth track, cacheable list results, the Tasks extension).

- [ ] **Step 7: Flip the roadmap row to shipped and mirror the handover**

Update the cycle 54 row status to `✅ shipped` with the CD run number and prod evidence. Mirror the handover to MyMind (`save_document` under `/projects/mymind/handovers/`), and close MyMind task `3e3c06b5`.

- [ ] **Step 8: Commit**

```bash
git add docs/handovers/2026-08-13-mcp-sdk-v2-migration.md docs/superpowers/plans/00-roadmap.md
git commit -m "docs(cycle-54): mark shipped — prod verified on a live legacy-era client"
```

---

## Notes for the implementer

**The three corrections that came out of spiking the real packages** — the spec was written from the published docs and was wrong in three places. All three are already fixed in the spec, but they are the traps most likely to be re-introduced:

1. **Nitro 2.13.4 runs h3 1.15.11, not h3 v2.** The `h3@2.0.1-rc.20` in the pnpm store belongs to a different consumer. Use `toWebRequest`, not any v2-only API.
2. **`registerTool` takes a bare `ZodRawShape`.** Do not wrap in `z.object()` — it is unnecessary and forks the shape shared with the agent path.
3. **`authInfo` cannot carry `event.context.client`.** Different shapes; do not invent values to bridge them.

**If you find yourself editing `test/mcp-parity.test.ts` or `test/mcp-dangerous.test.ts`, stop.** Those two tests passing unmodified is the definition of this migration staying in bounds. This project has been bitten before by subagents making a gate pass rather than making the code correct.
