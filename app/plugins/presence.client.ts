import { authClient } from '../lib/auth-client'

// Presence pings for delivery routing (cycle 75): while Tony is active in the web app, job
// results stay in the app instead of being texted. Posts POST /api/presence on keydown,
// pointerdown, focus, or the tab becoming visible — at most once per 60 s, and only while
// signed in (same session gate as live.client.ts). Errors are swallowed: presence is best-effort.
const THROTTLE_MS = 60_000

export default defineNuxtPlugin(() => {
  let signedIn = false
  let lastSentAt = 0

  function ping() {
    if (!signedIn) return
    const now = Date.now()
    if (now - lastSentAt < THROTTLE_MS) return
    lastSentAt = now
    $fetch('/api/presence', { method: 'POST' }).catch(() => {})
  }

  async function syncToSession() {
    try {
      const { data } = await authClient.getSession()
      const was = signedIn
      signedIn = !!data?.session
      if (signedIn && !was) ping() // count landing on the app (e.g. right after sign-in) as activity
    }
    catch { signedIn = false }
  }

  window.addEventListener('keydown', ping, { passive: true })
  window.addEventListener('pointerdown', ping, { passive: true })
  window.addEventListener('focus', ping)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ping()
  })

  syncToSession()
  useRouter().afterEach(() => { syncToSession() })
})
