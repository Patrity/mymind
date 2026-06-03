import { authClient } from '~/lib/auth-client'

// Client-only auth guard.
// Approach: skip on SSR to avoid cookie-forwarding complexity with better-auth 1.6.
// On the client, resolve the session once; redirect to /login if none present.
// This is safe for a single-user app where all meaningful data is behind API auth anyway.
export default defineNuxtRouteMiddleware(async (to) => {
  // Always allow public routes through — no session check needed.
  if (to.path === '/login' || to.path.startsWith('/share/')) return

  // Skip on the server: let the client handle the redirect.
  if (import.meta.server) return

  const { data } = await authClient.getSession()
  if (!data?.session) {
    return navigateTo('/login')
  }
})
