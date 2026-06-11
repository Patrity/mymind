// app/middleware/onboarding.global.ts
// After auth, gate the app behind onboarding until reasoning+embeddings are
// configured. Runs client-side (global ssr:false). Public + onboarding routes
// pass through; everything else redirects to /onboarding when unconfigured.
import { authClient } from '~/lib/auth-client'

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login' || to.path === '/onboarding' || to.path.startsWith('/share/')) return
  const { data } = await authClient.getSession()
  if (!data?.session) return  // auth.global.ts handles the login redirect

  const { needsOnboarding, refresh } = useAiConfigStatus()
  if (needsOnboarding.value === null) await refresh()
  if (needsOnboarding.value) return navigateTo('/onboarding')
})
