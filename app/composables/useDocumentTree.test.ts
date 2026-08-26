import { describe, it, expect, afterEach } from 'vitest'
import { createApp, effectScope, type App, type EffectScope } from 'vue'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { useOptimisticTreeMutation, TREE_KEY } from './useDocumentTree'
import type { TreeNode } from '~~/server/services/tree'

/**
 * `useOptimisticTreeMutation` calls `useQueryClient()`/`useMutation()`, both of which need a
 * live Vue injection context (`useQueryClient`) and an active effect scope (`useMutation`'s
 * internal `watch`/`onScopeDispose`) — the same requirements a real component's `<script
 * setup>` satisfies. `app.runWithContext` supplies the injection context outside of a mounted
 * component; wrapping it in `effectScope(true).run(...)` supplies the scope. Nothing here
 * mounts a component or touches the DOM — this is exercising the mutation lifecycle only.
 */
function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  const app: App = createApp({})
  app.use(VueQueryPlugin, { queryClient })
  const scope: EffectScope = effectScope(true)
  const run = <T>(fn: () => T): T => {
    let result!: T
    scope.run(() => {
      app.runWithContext(() => { result = fn() })
    })
    return result
  }
  return { queryClient, run, dispose: () => scope.stop() }
}

const d = (name: string, path: string, id = `id-${name}`): TreeNode =>
  ({ name, path, type: 'file', id, title: null })

/** A promise this test can resolve/reject on its own schedule, to sequence two mutations that
 *  are genuinely concurrent (not just two `await`s in a row). */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Real-timer poll — `onMutate`'s `await cancelQueries()` means the optimistic write doesn't
 *  land in the exact same microtask as `mutateAsync()` being called, so tests that need to
 *  observe it mid-flight (before the mutation itself resolves) poll for it instead of guessing
 *  a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

let disposers: (() => void)[] = []
afterEach(() => {
  disposers.forEach(d => d())
  disposers = []
})

describe('useOptimisticTreeMutation', () => {
  it('a failing mutation restores the prior tree', async () => {
    const { queryClient, run, dispose } = harness()
    disposers.push(dispose)
    const initial: TreeNode[] = [d('a.md', '/a.md')]
    queryClient.setQueryData(TREE_KEY, initial)

    const mutation = run(() => useOptimisticTreeMutation<undefined, void>({
      mutationFn: async () => { throw new Error('server rejected it') },
      applyOptimistic: tree => tree.filter(n => n.path !== '/a.md')
    }))

    await expect(mutation.mutateAsync(undefined)).rejects.toThrow('server rejected it')

    expect(queryClient.getQueryData<TreeNode[]>(TREE_KEY)).toEqual(initial)
  })

  it('a succeeding mutation leaves its own optimistic write in place (onSettled just invalidates)', async () => {
    const { queryClient, run, dispose } = harness()
    disposers.push(dispose)
    const initial: TreeNode[] = [d('a.md', '/a.md')]
    queryClient.setQueryData(TREE_KEY, initial)

    const mutation = run(() => useOptimisticTreeMutation<undefined, void>({
      mutationFn: async () => {},
      applyOptimistic: tree => tree.filter(n => n.path !== '/a.md')
    }))

    await mutation.mutateAsync(undefined)
    expect(queryClient.getQueryData<TreeNode[]>(TREE_KEY)).toEqual([])
  })

  it(
    'a failing mutation does NOT clobber a concurrent mutation\'s still-good optimistic write ' +
    '(regression for the generation-stamped rollback — fails against an unconditional restore)',
    async () => {
      const { queryClient, run, dispose } = harness()
      disposers.push(dispose)
      const initial: TreeNode[] = [d('a.md', '/a.md'), d('b.md', '/b.md')]
      queryClient.setQueryData(TREE_KEY, initial)

      const aGate = deferred<void>()

      // A: removes a.md, held open until we release it, then fails.
      const mutationA = run(() => useOptimisticTreeMutation<undefined, void>({
        mutationFn: async () => { await aGate.promise; throw new Error('A failed') },
        applyOptimistic: tree => tree.filter(n => n.path !== '/a.md')
      }))
      // B: removes b.md, resolves immediately (succeeds).
      const mutationB = run(() => useOptimisticTreeMutation<undefined, void>({
        mutationFn: async () => {},
        applyOptimistic: tree => tree.filter(n => n.path !== '/b.md')
      }))

      // 1. Start A. Its optimistic write lands first: only b.md left.
      const aPromise = mutationA.mutateAsync(undefined)
      await waitFor(() => {
        const t = queryClient.getQueryData<TreeNode[]>(TREE_KEY) ?? []
        return t.length === 1 && t[0]!.path === '/b.md'
      })

      // 2. Start B *while A is still in flight*. B's `onMutate` snapshots A's optimistic tree
      //    as ITS `previous` — this is the setup for the bug: B doesn't know A hasn't landed yet.
      await mutationB.mutateAsync(undefined)
      await waitFor(() => (queryClient.getQueryData<TreeNode[]>(TREE_KEY) ?? []).length === 0)

      // 3. Now let A fail. A's `onError` would restore `previous` = [a.md, b.md] unconditionally
      //    — discarding B's already-succeeded removal of b.md. It must not.
      aGate.resolve()
      await expect(aPromise).rejects.toThrow('A failed')

      const finalTree = queryClient.getQueryData<TreeNode[]>(TREE_KEY)
      expect(finalTree).toEqual([]) // b.md's removal survives A's failure
    }
  )
})
