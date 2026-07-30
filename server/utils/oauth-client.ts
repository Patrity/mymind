/**
 * Display helpers for the OAuth consent screen (`app/pages/oauth/consent.vue`).
 *
 * Dynamic client registration is deliberately OPEN (RFC 7591 — see the `mcp` plugin config in
 * `server/utils/auth.ts`), which makes `client_name` ATTACKER-CONTROLLED: anyone who can reach
 * `/api/auth/mcp/register` may register as "MyMind Official" and hope the user approves on the
 * strength of the name alone.
 *
 * The consent screen therefore never shows the name by itself. It pairs it with the redirect
 * host — the domain the authorization code is actually delivered to, which an attacker cannot
 * forge without controlling that domain — and the opaque client id. The name is a convenience;
 * the redirect host is the fact worth checking.
 */

/** Names longer than this are truncated so a crafted `client_name` can't blow out the layout. */
export const MAX_CLIENT_NAME_LEN = 60

/**
 * Human label for a registered client. Falls back to the raw client id when a client
 * registered without a usable name — ugly, but never misleading.
 *
 * Whitespace is collapsed (not just trimmed) so an embedded newline can't be used to push
 * the redirect host or the "only approve if you started this" warning out of view.
 */
export function clientDisplayName(name: string | null | undefined, clientId: string): string {
  const collapsed = (name ?? '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return clientId
  return collapsed.length > MAX_CLIENT_NAME_LEN
    ? `${collapsed.slice(0, MAX_CLIENT_NAME_LEN)}…`
    : collapsed
}

/**
 * Hosts from a client's registered redirect URIs. better-auth stores `redirect_urls` as a
 * comma-separated string. Unparseable entries are dropped rather than surfaced raw, and the
 * result is de-duplicated so several callback paths on one domain read as a single host.
 */
export function redirectHosts(redirectUrls: string | null | undefined): string[] {
  if (!redirectUrls) return []
  const hosts: string[] = []
  for (const entry of redirectUrls.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    try {
      const { host } = new URL(trimmed)
      if (host && !hosts.includes(host)) hosts.push(host)
    } catch {
      // A malformed redirect URI can't be rendered as a trustworthy origin — skip it.
    }
  }
  return hosts
}
