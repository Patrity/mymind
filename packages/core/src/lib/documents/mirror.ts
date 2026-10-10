/**
 * The repo-mirror convention (cycle 77 mirror guard). A doc under /projects/<slug>/wiki/ or
 * /projects/<slug>/handovers/ is synced one-way from the git repo by the wiki-mirror flow and
 * overwritten whole on its next sync, so an append into it is silently lost. The `documents`
 * table has no mirror marker; this path rule is the convention.
 *
 * A leaf module (no imports) so triage and the doc-candidate filer can both use it without an
 * import cycle.
 */
export function isRepoMirrorPath(path: string): boolean {
  return /^\/projects\/[^/]+\/(wiki|handovers)\//.test(path)
}
