import { authClient } from '~/lib/auth-client'

// Auth guard — runs client-side only (global ssr:false means no server pass).
// Checks the better-auth session and redirects to /login if unauthenticated.
// Public routes (/login, /share/**) are exempted from the session check.
export default defineNuxtRouteMiddleware(async (to) => {
  // Always allow public routes through — no session check needed.
  if (to.path === '/login' || to.path.startsWith('/share/')) return

  const { data } = await authClient.getSession()
  if (!data?.session) {
    return navigateTo('/login')
  }
})
