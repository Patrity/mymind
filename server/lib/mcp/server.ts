import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { agentTools } from '../agent/tools'

export function mcpToolNames(): string[] {
  return agentTools.filter(t => !t.dangerous).map(t => t.name)
}

export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' })
  for (const tool of agentTools) {
    if (tool.dangerous) continue // MCP has no approval channel — never expose a gated tool here
    server.tool(tool.name, tool.description, tool.schema, async (args: Record<string, unknown>) => {
      const ac = new AbortController()
      const exec = await tool.handler(args, { signal: ac.signal })
      return { content: [{ type: 'text' as const, text: JSON.stringify(exec.result) }] }
    })
  }
  return server
}
