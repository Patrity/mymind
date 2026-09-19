// Frees each Vite build's Rollup module graph when that build ends, instead of pinning it for the
// rest of `nuxt build` — and so through the whole Nitro server build.
//
// @tailwindcss/vite's `generate:build` transform caches one compiler per CSS root for the life of
// the plugin, and that compiler's `onDependency` callback closes over the transform's `this`
// (`R => this.addWatchFile(R)`). `this` is Rollup's plugin context, which references the entire
// module graph. Nuxt shares the Tailwind plugin between the client and SSR builds and keeps it
// reachable until the process exits, so BOTH graphs stayed alive into the Nitro phase. Measured
// on the cycle-65 branch (live heap after a forced full GC, right before Nitro starts): 2,847 MB
// without this module, 719 MB with it. That leak, not Nitro's own work, is what OOM'd
// `pnpm build` at deploy.yml's 4096 MB heap.
//
// The fix hands Tailwind's handler a call-scoped Proxy standing in for `this`
// (`createCallScopedThis`): it serves `environment` (captured once, at wrap time) and its own
// `addWatchFile` (forwarding to the live context) itself, and forwards any OTHER key the
// transform reads straight to the live context too — bound, and ONLY while that one call is in
// flight. `release()` runs in the wrapped call's `finally`, so the live reference never outlives
// the call; any access after that throws instead of returning stale data or silently going
// `undefined`, so a shape change that starts touching a new member fails loudly during the build
// rather than pinning the graph again unnoticed. Build-only (the Tailwind plugin is
// `apply: 'build'`; dev is untouched).
//
// If Tailwind's plugin shape ever changes (renamed, restructured, `transform` no longer the
// `{ handler }` object form), `wrapTailwindBuildTransform` warns and does nothing — the build
// still works, it just goes back to pinning ~2.1 GB of dead Rollup graphs into the Nitro phase,
// and a deploy build at deploy.yml's 4096 MB heap will likely OOM again. Fix this module first if
// that warning appears after a Tailwind/Vite/Nuxt upgrade.
import { addVitePlugin, defineNuxtModule, useLogger } from 'nuxt/kit'

export const TAILWIND_BUILD_PLUGIN = '@tailwindcss/vite:generate:build'
const WRAPPED = Symbol.for('mymind:tailwind-build-context')

type Handler = ((this: unknown, ...args: unknown[]) => unknown) & { [WRAPPED]?: true }
interface PluginLike { name?: string; transform?: unknown }
export interface ResolvedConfigLike { plugins: PluginLike[] }
export interface LoggerLike { warn: (msg: string) => void }

const RELEASED_MESSAGE = '[tailwind-build-context] this was accessed after its call ended — the stand-in is only live while the wrapped transform call is in flight (see modules/tailwind-build-context.ts)'

/** A Proxy standing in for Rollup's plugin context for the life of ONE call: `environment` is
 *  captured once at creation (Tailwind never needs a live read of it), `addWatchFile` forwards
 *  to the live context, and every OTHER key is forwarded to the live context too (bound, if it's
 *  a function) — an unexpected read degrades to "works, via the live object" rather than
 *  "silently undefined". `release()` drops the live reference; any access after that throws. */
export function createCallScopedThis<T extends { addWatchFile: (file: string) => void }>(liveCtx: T): { proxy: T, release: () => void } {
  let ctx: T | null = liveCtx
  const environment = (liveCtx as unknown as { environment?: unknown }).environment
  const assertLive = (): T => {
    if (ctx === null) throw new Error(RELEASED_MESSAGE)
    return ctx
  }
  const proxy = new Proxy({} as T, {
    get(_target, prop) {
      const live = assertLive()
      if (prop === 'environment') return environment
      if (prop === 'addWatchFile') return (file: string) => assertLive().addWatchFile(file)
      const value = Reflect.get(live as object, prop)
      return typeof value === 'function' ? value.bind(live) : value
    },
    has(_target, prop) {
      const live = assertLive()
      return prop === 'environment' || prop === 'addWatchFile' || Reflect.has(live as object, prop)
    }
  })
  return { proxy, release: () => { ctx = null } }
}

export type WrapOutcome = 'wrapped' | 'already-wrapped' | 'missing'

/** Finds Tailwind's build-time transform on a resolved Vite config and wraps its handler so each
 *  call gets a call-scoped stand-in `this` (`createCallScopedThis`) instead of the real Rollup
 *  plugin context. Idempotent — the client and SSR builds share one plugin object, so this runs
 *  twice; the second call is a no-op via the WRAPPED marker. Returns what happened so the caller
 *  can decide whether to log. */
export function wrapTailwindBuildTransform(config: ResolvedConfigLike, logger: LoggerLike): WrapOutcome {
  const hook = config.plugins.find(p => p.name === TAILWIND_BUILD_PLUGIN)?.transform
  const handler = hook && typeof hook === 'object' ? (hook as { handler?: unknown }).handler as Handler : undefined
  if (!hook || typeof handler !== 'function') {
    logger.warn(`\`${TAILWIND_BUILD_PLUGIN}\` not found or reshaped — Vite build graphs will stay pinned until exit; a deploy build at 4096 MB will likely OOM again (see modules/tailwind-build-context.ts)`)
    return 'missing'
  }
  if (handler[WRAPPED]) return 'already-wrapped'

  const wrapped: Handler = async function (this: unknown, ...args: unknown[]) {
    const { proxy, release } = createCallScopedThis(this as { addWatchFile: (file: string) => void })
    try {
      return await handler.apply(proxy, args)
    } finally {
      release()
    }
  }
  wrapped[WRAPPED] = true
  Object.assign(hook as object, { handler: wrapped })
  return 'wrapped'
}

export default defineNuxtModule({
  meta: { name: 'tailwind-build-context' },
  setup(_, nuxt) {
    if (nuxt.options.dev) return
    const logger = useLogger('tailwind-build-context')

    addVitePlugin({
      name: 'mymind:tailwind-build-context',
      apply: 'build',
      configResolved(config) {
        wrapTailwindBuildTransform(config as unknown as ResolvedConfigLike, logger)
      }
    })
  }
})
