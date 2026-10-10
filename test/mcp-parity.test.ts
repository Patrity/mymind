// test/mcp-parity.test.ts
import { describe, it, expect } from 'vitest'
import { agentTools } from '@mymind/core/lib/agent/tools'
import { mcpToolNames } from '../server/lib/mcp/server'

describe('MCP ↔ agent registry parity', () => {
  it('MCP exposes exactly the non-dangerous, non-Google agent registry tools', () => {
    const safeTools = agentTools.filter(t => !t.dangerous && t.toolset !== 'gmail' && (t.toolset as string) !== 'calendar').map(t => t.name).sort()
    expect(mcpToolNames().sort()).toEqual(safeTools)
  })
  it('never exposes Google tools (cycle 79): no gmail_*, contacts_search or calendar_*', () => {
    const names = mcpToolNames()
    expect(agentTools.some(t => t.name.startsWith('gmail_'))).toBe(true) // the filter has something to filter
    expect(names.filter(n => n.startsWith('gmail_') || n.startsWith('calendar_') || n === 'contacts_search')).toEqual([])
  })
  it('never exposes load_toolsets (cycle 78) — MCP clients already see every tool', () => {
    expect(agentTools.map(t => t.name)).not.toContain('load_toolsets')
    expect(mcpToolNames()).not.toContain('load_toolsets')
  })
})
