import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMcpServer } from '../../lib/mcp/server'

export default defineEventHandler(async (event) => {
  // Auth is already enforced by server/middleware/auth.ts (runs before all /api/** routes).
  // That middleware accepts both Bearer tokens and sessions, so if we reach this point
  // event.context.client is set and the caller is authenticated.

  // readBody so h3 doesn't leave the body stream half-consumed
  const body = await readBody(event)

  const server = buildMcpServer()
  const transport = new StreamableHTTPServerTransport({
    // stateless: no session tracking, new server+transport per request
    sessionIdGenerator: undefined
  })

  await server.connect(transport)

  // handleRequest writes directly to the Node.js ServerResponse via @hono/node-server.
  // We await it so that the response is fully written before we return.
  await transport.handleRequest(event.node.req, event.node.res, body)

  // Mark the h3 event as handled so the framework does not attempt to write a second
  // response (h3 v1 checks event._handled; v2 also checks res.headersSent which will
  // already be true once handleRequest completes, but being explicit is safer).
  event._handled = true
})
