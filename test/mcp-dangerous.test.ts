// test/mcp-dangerous.test.ts
// Asserts the invariant: dangerous tools are never exposed on the gateless MCP surface.
import { describe, it, expect } from 'vitest'
import { agentTools } from '@mymind/core/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'
import { execTool } from '@mymind/core/lib/agent/tools/exec'
import { bridgetProfile } from '@mymind/core/lib/agent/profile'
import { gmailSendTool } from '@mymind/core/lib/agent/tools/gmail'

describe('MCP dangerous-tool defense', () => {
  it('agentTools contains no dangerous tools today (exec/decide_review/gmail_send all live on the profile, not the registry)', () => {
    const dangerous = agentTools.filter(t => t.dangerous)
    expect(dangerous).toHaveLength(0)
  })

  // I1 (cycle 79 review, fix round 1): gmail_send must NOT live in the shared agentTools
  // registry — every agentTools consumer (MCP, replay, subagents, toolByName) would otherwise
  // be one forgotten `dangerous` check away from a gateless send. It lives on bridgetProfile
  // instead, next to exec/decide_review, the same way those two already do.
  it('gmail_send lives on bridgetProfile (dangerous, gmail toolset), never in agentTools', () => {
    expect(agentTools.find(t => t.name === 'gmail_send')).toBeUndefined()
    const onProfile = bridgetProfile.tools.find(t => t.name === 'gmail_send')
    expect(onProfile).toBeDefined()
    expect(onProfile).toBe(gmailSendTool)
    expect(onProfile!.dangerous).toBe(true)
    expect(onProfile!.toolset).toBe('gmail')
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
