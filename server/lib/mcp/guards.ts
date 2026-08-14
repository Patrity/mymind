/**
 * Hosts the MCP endpoint will answer on.
 *
 * `createMcpHandler` performs NO Host/Origin validation of its own (the v1 transport did), so
 * without this a DNS-rebinding attacker could reach /api/mcp from a victim's browser.
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
