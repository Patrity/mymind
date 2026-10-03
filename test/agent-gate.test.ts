import { describe, it, expect } from 'vitest'
import { classifyForHeadless, headlessTools } from '../server/lib/agent/runtime/gate'
import { bridgetProfile } from '../server/lib/agent/profile'
import { loadToolsetsTool } from '../server/lib/agent/tools/load-toolsets'
import type { AgentTool } from '../server/lib/agent/types'
import type { HeadlessClass } from '../server/lib/agent/runtime/gate'

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
  it('load_toolsets (cycle 78) runs headless — it is a read', () => {
    expect(classifyForHeadless(loadToolsetsTool)).toBe('run')
    expect(bridgetProfile.tools.map(t => t.name)).toContain('load_toolsets')
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

// A hand-written pin, independent of gate.ts's own logic — the tests above prove no tool
// throws and spot-check a handful by name, but neither catches a tool silently MOVING class
// (e.g. update_document sliding from PROPOSE_TOOLS into APPEND_TOOLS would still pass every
// test above while quietly letting a headless run mutate an existing document unattended).
// This table names every tool Bridget has and its expected class; it must be updated by hand
// whenever a tool is added, removed or reclassified.
const EXPECTED_CLASS: Record<string, HeadlessClass> = {
  // read — always safe to run headless
  search_memories: 'run', get_recent_memories: 'run', search_docs: 'run', search_passages: 'run',
  list_documents: 'run', get_document: 'run', read_document: 'run', grep_document: 'run',
  search_projects: 'run', get_project: 'run', search_tasks: 'run', web_search: 'run', web_fetch: 'run',
  search_messages: 'run', search_sessions: 'run', read_around_message: 'run', read_session: 'run',
  use_skill: 'run', research_web: 'run', search_brain: 'run',
  list_jobs: 'run', get_job: 'run',
  list_reviews: 'run',
  list_improvements: 'run',
  // load_toolsets (cycle 78): changes which tools the model sees this run — touches no data
  load_toolsets: 'run',
  // create-kind, but pure append (nothing existing is touched) — safe to run headless
  save_memory: 'run', create_task: 'run', create_project: 'run', quick_capture: 'run',
  generate_image: 'run', save_document: 'run',
  // jobs (spec D2): free even in a background run — Bridget's own upkeep, not Tony's data
  create_job: 'run', edit_job: 'run', run_job: 'run', schedule_wake: 'run', delete_job: 'run',
  // send_message (cycle 75, Task 10): Tony-only, rate-limited outbound note — an append, not a
  // change to his data, so it runs headless like the other append tools.
  send_message: 'run',
  // create-kind that edits/moves something that already exists — proposed, not run
  edit_document: 'propose', edit_section: 'propose', update_document: 'propose',
  move_document: 'propose', sync_document: 'propose', edit_image: 'propose',
  create_skill: 'propose', edit_skill: 'propose',
  // destructive-kind — always proposed
  forget_memory: 'propose', delete_document: 'propose', edit_project: 'propose',
  edit_task: 'propose', delete_task: 'propose', delete_skill: 'propose',
  // dangerous — excluded outright, never even offered as a proposal
  exec: 'exclude',
  // decide_review (cycle 76): dangerous — refused outright in a headless run, never proposed
  // (approving a proposal via a proposal is circular)
  decide_review: 'exclude'
}

describe('headless gate — exhaustive table', () => {
  it('the table names EXACTLY the tools Bridget has, no more, no less', () => {
    expect(Object.keys(EXPECTED_CLASS).sort()).toEqual(bridgetProfile.tools.map(t => t.name).sort())
  })
  it.each(bridgetProfile.tools.map(t => [t.name, t] as const))('%s classifies as pinned', (name, t) => {
    expect(classifyForHeadless(t)).toBe(EXPECTED_CLASS[name])
  })
})
