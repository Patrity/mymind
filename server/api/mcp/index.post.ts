import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { buildMcpServer } from '../../lib/mcp/server'
import { mcpAllowedHosts, mcpAllowedOrigins } from '../../lib/mcp/guards'

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

  // A request with no Origin always passes both helpers, so machine clients are unaffected.
  // Host and Origin use DIFFERENT allowlists on purpose — see the comment on mcpAllowedOrigins
  // for why. Host stays narrow (our domain + loopback); Origin also allows claude.ai/claude.com
  // so the OAuth connector's cross-site requests aren't rejected.
  const betterAuthUrl = useRuntimeConfig().betterAuthUrl as string | undefined
  const rejected = hostHeaderValidationResponse(request, mcpAllowedHosts(betterAuthUrl))
    ?? originValidationResponse(request, mcpAllowedOrigins(betterAuthUrl))
  if (rejected) return rejected

  return await mcpHandler.fetch(request, { parsedBody: body })
})
