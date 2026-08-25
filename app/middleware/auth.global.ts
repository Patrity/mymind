import { authClient } from '~/lib/auth-client'

// Auth guard — runs client-side only (global ssr:false means no server pass).
// Checks the better-auth session and redirects to /login if unauthenticated.
// Public routes (/login, /share/**) are exempted from the session check.
export default defineNuxtRouteMiddleware(async (to) => {
  // Always allow public routes through — no session check needed.
  if (to.path === '/login' || to.path.startsWith('/share/')) return

  const { data } = await authClient.getSession()
  if (!data?.session) {
    // Carry the intended route through the login round-trip. Without this, a bookmarked or
    // shared deep link (`/projects/mymind`, `/gallery?image=…`) was dropped here and the user
    // always landed on `/` after signing in. `fullPath` so query + hash survive too.
    // The login page re-validates the param before using it (see ~/lib/auth-redirect).
    return to.fullPath === '/'
      ? navigateTo('/login')
      : navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
