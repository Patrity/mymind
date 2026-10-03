// test/mcp-parity.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools } from '../server/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'

describe('MCP ↔ agent registry parity', () => {
  it('MCP exposes exactly the non-dangerous agent registry tools', () => {
    const safeTools = agentTools.filter(t => !t.dangerous).map(t => t.name).sort()
    expect(mcpToolNames().sort()).toEqual(safeTools)
  })
  it('never exposes load_toolsets (cycle 78) — MCP clients already see every tool', () => {
    expect(agentTools.map(t => t.name)).not.toContain('load_toolsets')
    expect(mcpToolNames()).not.toContain('load_toolsets')
  })
})
