import { VueQueryPlugin, QueryClient, hydrate, dehydrate } from '@tanstack/vue-query'

// Named so the live-sse plugin can declare `dependsOn: ['vue-query']` and be
// guaranteed to run AFTER the QueryClient exists (plugin filenames sort
// 'live.client' < 'vue-query', so without this the consumer would run first).
export default defineNuxtPlugin({
  name: 'vue-query',
  setup(nuxt) {
    const vueQueryState = useState<unknown>('vue-query')

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,        // live events drive freshness; this just debounces refetches
          refetchOnReconnect: true, // self-heals missed invalidations after an SSE/network gap
          refetchOnWindowFocus: false
        }
      }
    })

    nuxt.vueApp.use(VueQueryPlugin, { queryClient })

    if (import.meta.server) {
      nuxt.hooks.hook('app:rendered', () => { vueQueryState.value = dehydrate(queryClient) })
    }
    if (import.meta.client) {
      hydrate(queryClient, vueQueryState.value)
    }

    // Expose via Nuxt's provide so other plugins read it as `nuxtApp.$queryClient`
    // (no Vue injection context needed — plugins have no component instance).
    return { provide: { queryClient } }
  }
})
