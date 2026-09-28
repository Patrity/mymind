import { describe, it, expect, afterEach, vi } from 'vitest'
import { createApp, effectScope, nextTick } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { useConfigSource } from './useConfigSource'

/** useConfigSource needs an injection context (useQueryClient) and an effect scope (useQuery's
 *  watchers) — the same harness as useDocumentTree.test.ts. $fetch is stubbed. */
function harness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const app = createApp({})
  app.use(VueQueryPlugin, { queryClient })
  const scope = effectScope(true)
  let result!: ReturnType<typeof useConfigSource>
  scope.run(() => app.runWithContext(() => {
    result = useConfigSource('job', 'scratch')
  }))
  return { src: result, dispose: () => scope.stop() }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
  vi.unstubAllGlobals()
})

describe('useConfigSource — rejected save', () => {
  it('shows the validation message, then clears it on the next edit', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'PUT') throw Object.assign(new Error('400'), { status: 400, data: { statusMessage: 'trigger must fire at least 5 minutes apart' } })
      return { job: { content: 'a', contentHash: 'h1' }, nextFireTimes: [], runs: [] }
    }))
    const h = harness()
    dispose = h.dispose
    const { src } = h
    await waitFor(() => src.loaded.value)

    src.content.value = 'b'
    expect(await src.save()).toBe(false)
    expect(src.error.value).toBe('trigger must fire at least 5 minutes apart')

    src.content.value = 'c'
    await nextTick()
    expect(src.error.value).toBeNull()
    expect(src.dirty.value).toBe(true)
  })
})
