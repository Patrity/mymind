// test/mcp-dangerous.test.ts
// Asserts the invariant: dangerous tools are never exposed on the gateless MCP surface.
import { describe, it, expect } from 'vitest'
import { agentTools } from '../server/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'
import { execTool } from '../server/lib/agent/tools/exec'

describe('MCP dangerous-tool defense', () => {
  it('agentTools contains no dangerous tools today (exec lives on the profile, not the registry)', () => {
    const dangerous = agentTools.filter(t => t.dangerous)
    expect(dangerous).toHaveLength(0)
  })

  it('subagent tools live on the profile, not in agentTools → absent from MCP', () => {
    const names = mcpToolNames()
    expect(names).not.toContain('research_web')
    expect(names).not.toContain('search_brain')
  })

  it('execTool is marked dangerous', () => {
    expect(execTool.dangerous).toBe(true)
  })

  it('mcpToolNames excludes any dangerous tool from the registry', () => {
    const names = mcpToolNames()
    const dangerousNames = agentTools.filter(t => t.dangerous).map(t => t.name)
    for (const name of dangerousNames) {
      expect(names).not.toContain(name)
    }
  })

  it('exec tool name is absent from mcpToolNames (even though execTool is not in agentTools today)', () => {
    // Belt-and-suspenders: if exec were ever accidentally added to agentTools,
    // the MCP surface must not expose it.
    expect(mcpToolNames()).not.toContain(execTool.name)
  })
})
