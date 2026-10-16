// test/mcp-dangerous.test.ts
// Asserts the invariant: dangerous tools are never exposed on the gateless MCP surface.
import { describe, it, expect } from 'vitest'
import { agentTools } from '@mymind/core/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'
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

  it('mcpToolNames excludes any dangerous tool from the registry', () => {
    const names = mcpToolNames()
    const dangerousNames = agentTools.filter(t => t.dangerous).map(t => t.name)
    for (const name of dangerousNames) {
      expect(names).not.toContain(name)
    }
  })

})

// Cycle 82/86: the workspace (Bridget's own Mac) is Bridget's alone — never on /api/mcp. Two layers:
// the tools live on bridgetProfile (not agentTools), AND the MCP filter excludes the `workspace`
// toolset, so a future move into agentTools still hides them.
describe('MCP — workspace toolset (cycle 82)', () => {
  it('no workspace tool is in agentTools, and none reaches mcpToolNames', async () => {
    const { workspaceTools } = await import('@mymind/core/lib/agent/tools/workspace')
    const names = mcpToolNames()
    for (const t of workspaceTools) {
      expect(agentTools.find(x => x.name === t.name), t.name).toBeUndefined()
      expect(names, t.name).not.toContain(t.name)
      expect(bridgetProfile.tools).toContain(t)
    }
  })
  it('isMcpExposed refuses the workspace toolset even for a non-dangerous tool', async () => {
    const { isMcpExposed, MCP_EXCLUDED_TOOLSETS } = await import('../server/lib/mcp/server')
    expect([...MCP_EXCLUDED_TOOLSETS]).toEqual(expect.arrayContaining(['workspace']))
    const { workspaceTools } = await import('@mymind/core/lib/agent/tools/workspace')
    for (const t of workspaceTools) expect(isMcpExposed({ ...t, dangerous: false }), t.name).toBe(false)
  })
})
