import { VueQueryPlugin, QueryClient, hydrate, dehydrate } from '@tanstack/vue-query'

export default defineNuxtPlugin((nuxt) => {
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
})
