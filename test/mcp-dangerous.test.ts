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

// Cycle 82 (spec §4/§5): the sandboxed workspace and host exec are Bridget's alone — never on
// /api/mcp. Two layers: the tools live on bridgetProfile (not agentTools), AND the MCP filter
// excludes the `workspace` and `admin` toolsets, so a future move into agentTools still hides them.
describe('MCP — workspace + admin toolsets (cycle 82)', () => {
  it('no workspace tool is in agentTools, and none reaches mcpToolNames', async () => {
    const { workspaceTools } = await import('@mymind/core/lib/agent/tools/workspace')
    const names = mcpToolNames()
    for (const t of workspaceTools) {
      expect(agentTools.find(x => x.name === t.name), t.name).toBeUndefined()
      expect(names, t.name).not.toContain(t.name)
      expect(bridgetProfile.tools).toContain(t)
    }
  })
  it('isMcpExposed refuses the workspace and admin toolsets even for a non-dangerous tool', async () => {
    const { isMcpExposed, MCP_EXCLUDED_TOOLSETS } = await import('../server/lib/mcp/server')
    expect([...MCP_EXCLUDED_TOOLSETS]).toEqual(expect.arrayContaining(['workspace', 'admin']))
    const { workspaceTools } = await import('@mymind/core/lib/agent/tools/workspace')
    for (const t of workspaceTools) expect(isMcpExposed(t), t.name).toBe(false)
    expect(isMcpExposed({ ...execTool, dangerous: false })).toBe(false) // admin, even ungated
  })
})
