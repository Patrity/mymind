// Cycle 83 Task 2 — which model a workstream segment runs on (spec §3): the pool hook
// (segmentPrimaryModelId — the pool key stamped on the segment) and the runner's chain (carried C2:
// a child's chain is built from `subagents`, never from `reasoning` alone), plus the coordinator's
// and the child's prompt rules and spawn_workstreams' model list.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let stored: unknown = null
vi.mock('@mymind/core/lib/ai/registry/store', async () => {
  const { parseConfig } = await import('@mymind/core/lib/ai/registry/schema')
  const { emptyDoc } = await import('@mymind/core/lib/ai/registry/types')
  return { loadConfig: async () => (stored ? parseConfig(stored) : emptyDoc()), saveConfig: async () => {}, invalidate: () => {} }
})

const { emptyDoc } = await import('@mymind/core/lib/ai/registry/types')
const { segmentPrimaryModelId, childChain } = await import('@mymind/core/lib/agent/runtime/pools')
const { agentChain } = await import('@mymind/core/lib/agent/model')
const { workstreamBlock } = await import('@mymind/core/lib/agent/prompt')
const { coordinatorProfile } = await import('@mymind/core/lib/agent/profile')
const { modelsText } = await import('@mymind/core/lib/agent/tools/coordinator')

type M = { id: string; label: string; description?: string | null }
function doc(models: M[], assignments: Partial<Record<string, string[]>>) {
  return {
    version: 1 as const,
    providers: [{ id: 'p1', name: 'Local', kind: 'openai-compatible' as const, baseURL: 'http://x/v1', apiKeyEnc: null }],
    models: models.map(m => ({ providerId: 'p1', modelId: m.id, dim: null, contextWindow: null, description: null, maxInFlight: null, ...m })),
    assignments: { ...emptyDoc().assignments, ...assignments }
  }
}
const MODELS: M[] = [{ id: 'r1', label: 'R1' }, { id: 'r2', label: 'R2' }, { id: 's1', label: 'Fast', description: 'fast, long context: research' }, { id: 's2', label: 'Deep' }]
// Fix round 1 (I2): a child is `isChild` (set at spawn), not "has a parent_id".
const child = (modelLabel: string | null) => ({ isChild: true, modelLabel })
const top = { isChild: false, modelLabel: null }

beforeEach(() => { stored = doc(MODELS, { reasoning: ['r1', 'r2'], subagents: ['s1', 's2'] }) })

describe('pool hook: segmentPrimaryModelId', () => {
  it('a child with a label → that subagents model; no label → the FIRST subagents model', async () => {
    expect(await segmentPrimaryModelId(child('Deep'))).toBe('s2')
    expect(await segmentPrimaryModelId(child(null))).toBe('s1')
  })
  it('a coordinator / any top-level workstream → the head of reasoning, whatever subagents holds', async () => {
    expect(await segmentPrimaryModelId(top)).toBe('r1')
  })
  it('empty subagents → a child runs on reasoning', async () => {
    stored = doc(MODELS, { reasoning: ['r2', 'r1'], subagents: [] })
    expect(await segmentPrimaryModelId(child(null))).toBe('r2')
  })
  it('a label removed from subagents since the spawn falls back to the default (never fails every segment)', async () => {
    expect(await segmentPrimaryModelId(child('Gone'))).toBe('s1')
    expect((await childChain('Gone')).map(m => m.modelDefId)).toEqual(['s1', 's2', 'r1', 'r2'])
  })
  it('AI not configured → null (unpooled)', async () => {
    stored = null
    expect(await segmentPrimaryModelId(child(null))).toBeNull()
    expect(await segmentPrimaryModelId(top)).toBeNull()
  })
})

describe('the runner\'s chain (carried C2): agentChain', () => {
  it('a child: label → rest of subagents → reasoning (never reasoning alone)', async () => {
    expect((await agentChain({ subagent: { label: 'Deep' }, modelDefId: 's2' })).map(m => m.modelDefId)).toEqual(['s2', 's1', 'r1', 'r2'])
    expect((await agentChain({ subagent: { label: null }, modelDefId: 's1' })).map(m => m.modelDefId)).toEqual(['s1', 's2', 'r1', 'r2'])
  })
  it('the stamped primary goes first even when it is not the label\'s head (config changed since enqueue)', async () => {
    expect((await agentChain({ subagent: { label: 'Fast' }, modelDefId: 's2' })).map(m => m.modelDefId)).toEqual(['s2', 's1', 'r1', 'r2'])
  })
  it('no subagent (chat, jobs, coordinators): the reasoning chain only', async () => {
    expect((await agentChain({ modelDefId: 'r2' })).map(m => m.modelDefId)).toEqual(['r2', 'r1'])
    expect((await agentChain({})).map(m => m.modelDefId)).toEqual(['r1', 'r2'])
  })
  it('the hook and the chain agree: the pool key is the model tried first', async () => {
    for (const label of ['Fast', 'Deep', null, 'Gone']) {
      const key = await segmentPrimaryModelId(child(label))
      expect((await agentChain({ subagent: { label }, modelDefId: key }))[0]!.modelDefId).toBe(key)
    }
  })
})

describe('prompt rules and the spawn description', () => {
  const base = { goal: 'G', used: { steps: 0, wallMs: 0 }, budget: { maxSteps: 400, maxWallMs: 7_200_000 } }
  it('a coordinator is told to plan, pick models by description, wait instead of polling, merge, and finish only when children are terminal', () => {
    const t = workstreamBlock({ ...base, role: { kind: 'coordinator' } }).join('\n')
    expect(t).toMatch(/COORDINATOR/)
    expect(t).toMatch(/Plan the split first/)
    expect(t).toMatch(/descriptions in `spawn_workstreams`/)
    expect(t).toMatch(/`wait_for_workstreams` — do NOT poll/)
    expect(t).toMatch(/Merge the children's results yourself/)
    expect(t).toMatch(/refused while any child is still running/)
  })
  it('a child reports with finish_workstream; ask_tony reaches its coordinator; its workspace mode is named', () => {
    const own = workstreamBlock({ ...base, role: { kind: 'child', coordinatorGoal: 'COORD GOAL', workspace: 'own' } }).join('\n')
    expect(own).toContain('a coordinator working on "COORD GOAL"')
    expect(own).toMatch(/Report with `finish_workstream`/)
    expect(own).toMatch(/`ask_tony` reaches your coordinator first/)
    expect(own).toMatch(/export_to_coordinator/)
    expect(workstreamBlock({ ...base, role: { kind: 'child', coordinatorGoal: 'x', workspace: 'shared' } }).join('\n')).toMatch(/coordinator's workspace \(shared\)/)
    expect(workstreamBlock(base).join('\n')).not.toMatch(/COORDINATOR|CHILD/)
  })
  it('spawn_workstreams lists the subagents labels and descriptions (the first is the default)', () => {
    const models = [{ label: 'Fast', description: 'fast, long context: research', maxInFlight: 6 }, { label: 'Deep', description: null, maxInFlight: 6 }]
    const spawn = coordinatorProfile(models).tools.find(t => t.name === 'spawn_workstreams')!
    expect(spawn.description).toContain('default "Fast"')
    expect(spawn.description).toContain('- "Fast" — fast, long context: research')
    expect(spawn.description).toContain('- "Deep"')
    expect(modelsText([])).toMatch(/none configured for subagents — leave "model" out/)
  })
})
