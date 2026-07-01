import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { agentTools } from '../agent/tools'

export function mcpToolNames(): string[] {
  return agentTools.filter(t => !t.dangerous).map(t => t.name)
}

const MCP_INSTRUCTIONS = `MyMind is Tony's second brain — a persistent, cross-session store of his documents, memories, tasks, and projects.

Work with it, not around it:
- Before answering from your own recollection, SEARCH here first (search_memories, search_docs, search_passages). What you remember may be stale; this is the source of truth.
- Persist durable outcomes: save_memory for a one-sentence fact; save_document for substantive work. File things under their project (pass a project slug).
- Edit in place. For a long document, read_document (outline/section) or grep_document to locate, then edit_document (exact find/replace) or edit_section — do NOT rewrite a whole document for a small change.
- Keep it tidy: move_document to file, delete_document / delete_task / forget_memory to retire. All are reversible via undo.

Records here outlive this conversation — keep them accurate and well-filed.`

export function buildMcpServer() {
  const server = new McpServer({ name: 'mymind', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS })
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
