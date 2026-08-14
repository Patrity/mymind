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
