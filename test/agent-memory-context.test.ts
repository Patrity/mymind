// test/agent-memory-context.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildMemoryContext } from '../server/lib/agent/context'
import { handleTurn } from '../server/lib/voice/orchestrator'
import type { MemoryDTO } from '../shared/types/memory'

const mem = (content: string, relevance: number) => ({ content, relevance }) as MemoryDTO

describe('buildMemoryContext', () => {
  it('formats top relevant memories as a labeled background block', async () => {
    const search = vi.fn(async () => [mem('Tony prefers pnpm', 1), mem('Prod is LXC 114', 0.5)])
    const out = await buildMemoryContext('how do I deploy', { search })
    expect(out).toMatch(/^Possibly relevant memories/)
    expect(out).toContain('- Tony prefers pnpm')
    expect(out).toContain('- Prod is LXC 114')
    expect(search).toHaveBeenCalledWith('how do I deploy', { limit: 5 })
  })

  it('drops low-relevance results and returns "" when nothing clears the floor', async () => {
    const search = vi.fn(async () => [mem('noise', 0.1)])
    expect(await buildMemoryContext('q', { search })).toBe('')
  })

  it('returns "" on empty input, empty results, and search errors (never throws)', async () => {
    expect(await buildMemoryContext('  ', { search: vi.fn() })).toBe('')
    expect(await buildMemoryContext('q', { search: vi.fn(async () => []) })).toBe('')
    expect(await buildMemoryContext('q', { search: vi.fn(async () => { throw new Error('db down') }) })).toBe('')
  })
})

describe('handleTurn memory injection', () => {
  it('appends the memory block to the context passed to runAgent', async () => {
    let seenContext: string | undefined
    const runAgent = (async function* (_m: unknown, ctx: { context?: string }) {
      seenContext = ctx.context
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'done' }
    }) as never
    await handleTurn('what do you know about my RAM', [], {
      tts: { synthesize: async function* () {} }, voice: '', speak: false,
      context: 'Current context: open tasks…',
      buildMemoryContext: async () => 'Possibly relevant memories:\n- Tony has 656GB of DDR4',
      runAgent, signal: new AbortController().signal, emit: () => {}
    })
    expect(seenContext).toContain('Current context: open tasks…')
    expect(seenContext).toContain('Tony has 656GB of DDR4')
  })

  it('passes the base context unchanged when no memories are found', async () => {
    let seenContext: string | undefined
    const runAgent = (async function* (_m: unknown, ctx: { context?: string }) {
      seenContext = ctx.context
      yield { type: 'done' }
    }) as never
    await handleTurn('hello', [], {
      tts: { synthesize: async function* () {} }, voice: '', speak: false,
      context: 'Current context: X',
      buildMemoryContext: async () => '',
      runAgent, signal: new AbortController().signal, emit: () => {}
    })
    expect(seenContext).toBe('Current context: X')
  })
})
