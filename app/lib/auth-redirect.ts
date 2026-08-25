/**
 * Sanitize a `?redirect=` value from the login URL into a same-origin path we are willing to
 * navigate to after sign-in.
 *
 * The auth guard writes this param from the route the user was actually headed for, so in the
 * normal flow the value came from our own middleware. It is still attacker-supplied in a
 * hand-crafted link (`/login?redirect=//evil.com`), so treat it as untrusted: only ever return
 * a rooted, single-slash internal path.
 */
export function safeRedirect(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  // Backslashes and control characters are the usual smuggling vectors — browsers normalise
  // `/\host` into `//host`, and strip embedded tabs/newlines, before resolving the URL.
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (ch === '\\' || code < 0x20 || code === 0x7f) return null
  }
  // `//host` is protocol-relative: an off-site jump once the browser resolves it. An absolute
  // URL (`https://…`) fails the leading-slash check outright.
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  // Bouncing back to /login would just loop the user through the form again.
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login#')) return null
  return raw
}
