// test/mcp-parity.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools } from '../server/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'

describe('MCP ↔ agent registry parity', () => {
  it('MCP exposes exactly the non-dangerous agent registry tools', () => {
    const safeTools = agentTools.filter(t => !t.dangerous).map(t => t.name).sort()
    expect(mcpToolNames().sort()).toEqual(safeTools)
  })
})
