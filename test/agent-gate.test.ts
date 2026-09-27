import { describe, it, expect } from 'vitest'
import { classifyForHeadless, headlessTools } from '../server/lib/agent/runtime/gate'
import { bridgetProfile } from '../server/lib/agent/profile'
import type { AgentTool } from '../server/lib/agent/types'

describe('headless gate', () => {
  it('classifies every tool Bridget has — a new unclassified tool fails this test', () => {
    for (const t of bridgetProfile.tools) expect(() => classifyForHeadless(t)).not.toThrow()
  })
  it('never lets exec (or any dangerous tool) into a headless run', () => {
    const tools = headlessTools(bridgetProfile.tools, { id: 'r', conversationId: 'c' }, async () => 'x')
    expect(tools.find(t => t.name === 'exec')).toBeUndefined()
    expect(tools.some(t => t.dangerous)).toBe(false)
  })
  it.each(['search_memories', 'read_document', 'web_fetch', 'use_skill', 'research_web'])('%s runs', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('run')
  })
  it.each(['save_memory', 'create_task', 'quick_capture', 'save_document'])('%s (append) runs', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('run')
  })
  it.each(['edit_task', 'delete_task', 'forget_memory', 'delete_document', 'edit_document', 'move_document', 'create_skill', 'edit_skill', 'edit_project'])('%s is proposed', (n) => {
    expect(classifyForHeadless(bridgetProfile.tools.find(t => t.name === n)!)).toBe('propose')
  })
  it('a proposed tool does not run its handler and returns the proposal receipt', async () => {
    let ran = false
    const fake: AgentTool = { name: 'edit_task', description: '', schema: {}, kind: 'destructive', handler: async () => { ran = true; return { result: 1, summary: '' } } }
    const [gated] = headlessTools([fake], { id: 'run-1', conversationId: 'c-1' }, async (p) => { expect(p).toMatchObject({ runId: 'run-1', conversationId: 'c-1', tool: 'edit_task', args: { id: 't' } }); return 'rev-1' })
    const out = await gated!.handler({ id: 't' }, { signal: new AbortController().signal })
    expect(ran).toBe(false)
    expect(out.result).toEqual({ proposed: true, reviewId: 'rev-1', note: "Queued for Tony's approval in /review." })
  })
  it('an unknown create-kind tool throws rather than defaulting to run', () => {
    const t: AgentTool = { name: 'brand_new_tool', description: '', schema: {}, kind: 'create', handler: async () => ({ result: 1, summary: '' }) }
    expect(() => classifyForHeadless(t)).toThrow(/unclassified/)
  })
})
