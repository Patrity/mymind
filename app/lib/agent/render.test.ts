import { describe, it, expect } from 'vitest'
import { uiMessageText, subagentSteps, tokenLabel, toolTitle, isRunning } from './render'
import type { AgentUIMessage } from '~~/shared/types/agent-ui'

const m: AgentUIMessage = {
  id: 'a', role: 'assistant',
  parts: [
    { type: 'text', text: 'Looking. ', state: 'done' },
    { type: 'dynamic-tool', toolName: 'research_web', toolCallId: 'c1', state: 'input-available', input: {} },
    { type: 'data-subagent', id: 'c1', data: { steps: [{ callId: 'n1', name: 'web_search', state: 'running' }] } },
    { type: 'text', text: 'Done.', state: 'done' }
  ]
}

describe('render helpers', () => {
  it('uiMessageText joins text parts only', () => { expect(uiMessageText(m)).toBe('Looking. Done.') })
  it('subagentSteps finds the data part for a tool call', () => {
    expect(subagentSteps(m, 'c1')).toEqual([{ callId: 'n1', name: 'web_search', state: 'running' }])
    expect(subagentSteps(m, 'nope')).toBeNull()
  })
  it('tokenLabel renders nothing for absent/zero usage', () => {
    expect(tokenLabel(undefined)).toBe('')
    expect(tokenLabel({ totalTokens: 0 })).toBe('')
    expect(tokenLabel({ totalTokens: 950 })).toBe('950 tok')
    expect(tokenLabel({ totalTokens: 1840 })).toBe('1.8k tok')
  })
  it('toolTitle humanizes snake_case', () => { expect(toolTitle('research_web')).toBe('Research web') })
  it('isRunning is true only for unfinished tools', () => {
    expect(isRunning(m.parts[1]!)).toBe(true)
    expect(isRunning(m.parts[0]!)).toBe(false)
  })
})
