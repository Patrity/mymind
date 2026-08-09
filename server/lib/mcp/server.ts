import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { agentTools } from '../agent/tools'

export function mcpToolNames(): string[] {
  return agentTools.filter(t => !t.dangerous).map(t => t.name)
}

export const MCP_INSTRUCTIONS = `MyMind is Tony's second brain — a persistent, cross-session store of his documents, memories, tasks, and projects.

Work with it, not around it:
- Before answering from your own recollection, SEARCH here first (search_memories, search_docs, search_passages). What you remember may be stale; this is the source of truth.
- Persist durable outcomes: save_memory for a one-sentence fact; save_document for substantive work. File things under their project (pass a project slug).
- Editing: hold the file? sync_document matches it in one call — probe with local_hash first to skip the transfer when nothing changed. No file? read_document/grep_document to locate, then edit_document (find/replace) or edit_section — don't rewrite a whole doc for a small change.
- Keep it tidy: move_document to file, delete_document / delete_task / forget_memory to retire. There is no undo tool here — get writes right the first time.

Records here outlive this conversation — keep them accurate and well-filed.`

/**
 * MCP clients never get an undo token: the handler below returns `exec.result` only — it never
 * calls `registerUndo(exec.undo)`, no `undo` tool exists in `agentTools`, and `runUndo`'s only
 * route (`POST /api/agent/undo`) is a Nitro REST endpoint an MCP session cannot reach. So the
 * preamble above must not tell an MCP agent to "check the undo result": that was advice for a
 * capability its only audience structurally does not have. The undo guards elsewhere in this
 * codebase are real, but only for the in-app agent surface. If an `undo` tool is ever exposed
 * here, revisit that preamble line.
 */
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
