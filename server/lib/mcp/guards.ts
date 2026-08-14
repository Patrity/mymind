/**
 * Hosts the MCP endpoint will answer on.
 *
 * `createMcpHandler` performs NO Host/Origin validation of its own, so without this a
 * DNS-rebinding attacker could reach /api/mcp from a victim's browser. This is net-new
 * hardening, NOT a restoration: the v1 SDK offered `enableDnsRebindingProtection`, but it
 * defaults to false and this endpoint never set it, so /api/mcp had no such validation before.
 *
 * Takes the configured URL as a PARAMETER rather than reading useRuntimeConfig() itself: this
 * module is imported by tests, where Nitro's auto-imports do not exist. Mirrors how
 * server/utils/oauth-metadata.ts takes `betterAuthUrl` from its caller.
 *
 * Returns hostnames only — the SDK's validators are port-agnostic.
 */
export function mcpAllowedHosts(betterAuthUrl?: string): string[] {
  const local = ['localhost', '127.0.0.1', '[::1]']
  if (!betterAuthUrl) return local // fail closed: never allow every Host when unconfigured
  try {
    return [new URL(betterAuthUrl).hostname, ...local]
  } catch {
    return local
  }
}

/**
 * Origins the MCP endpoint will answer on — deliberately WIDER than `mcpAllowedHosts`.
 *
 * Host and Origin defend different things, and conflating them would reopen the hole this guard
 * exists to close:
 *  - Host must stay strictly our own domain plus loopback. That header is what a DNS-rebinding
 *    attacker controls to make a victim's browser believe it's talking to this origin server, so
 *    widening it to include a third party (even a trusted one like claude.ai) would let that
 *    third party's DNS answer double as ours.
 *  - Origin is the cross-site check: it says which page's JS is allowed to script a request into
 *    this endpoint. Anthropic's connector fetcher (claude.ai / claude.com) legitimately sends
 *    `Origin: https://claude.ai` and belongs on THIS list only.
 *
 * Built on top of `mcpAllowedHosts` (not a parallel fallback) so the loopback/configured-host
 * base can't drift between the two lists — do not merge these back into one shared allowlist.
 */
export function mcpAllowedOrigins(betterAuthUrl?: string): string[] {
  return [...mcpAllowedHosts(betterAuthUrl), 'claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com']
}
