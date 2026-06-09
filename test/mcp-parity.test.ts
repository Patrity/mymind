// test/mcp-parity.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools } from '../server/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'

describe('MCP ↔ agent registry parity', () => {
  it('MCP exposes exactly the agent registry tools', () => {
    expect(mcpToolNames().sort()).toEqual(agentTools.map(t => t.name).sort())
  })
})
