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
// The fix hands Tailwind's handler a stand-in `this` carrying only what it uses (`environment`,
// `addWatchFile`); the stand-in forwards to the real context only while its own call is in flight,
// so the cached compiler ends up holding nothing but the stand-in. Build-only (the Tailwind plugin
// is `apply: 'build'`; dev is untouched). If Tailwind's plugin shape ever changes, this warns and
// does nothing — the build still works, it just stops freeing the graphs.
import { addVitePlugin, defineNuxtModule, useLogger } from 'nuxt/kit'

const TAILWIND_BUILD_PLUGIN = '@tailwindcss/vite:generate:build'
const WRAPPED = Symbol.for('mymind:tailwind-build-context')

type Handler = ((this: unknown, ...args: unknown[]) => unknown) & { [WRAPPED]?: true }
interface TransformContext {
  environment?: unknown
  addWatchFile: (file: string) => void
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
        const hook = config.plugins.find(p => p.name === TAILWIND_BUILD_PLUGIN)?.transform
        const handler = hook && typeof hook === 'object' ? hook.handler as Handler : undefined
        if (!hook || typeof handler !== 'function') {
          logger.warn(`\`${TAILWIND_BUILD_PLUGIN}\` not found or reshaped — Vite build graphs will stay pinned until exit (see modules/tailwind-build-context.ts)`)
          return
        }
        // The client and SSR builds share one Tailwind plugin object: wrap it once.
        if (handler[WRAPPED]) return

        const wrapped: Handler = async function (this: unknown, ...args: unknown[]) {
          let ctx = this as TransformContext | null
          const standIn: TransformContext = {
            environment: (this as TransformContext).environment,
            addWatchFile: (file: string) => ctx?.addWatchFile(file)
          }
          try {
            return await handler.apply(standIn, args)
          } finally {
            ctx = null
          }
        }
        wrapped[WRAPPED] = true
        Object.assign(hook, { handler: wrapped })
      }
    })
  }
})
