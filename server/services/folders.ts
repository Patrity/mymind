import { useDb } from '../db'
import { folders } from '../db/schema'

type Db = ReturnType<typeof useDb>

/**
 * The folder path itself plus every ancestor, root-first.
 * '/projects/mymind/wiki' → ['/projects', '/projects/mymind', '/projects/mymind/wiki']
 * '/' or '' → [] — the root is never a folder row.
 *
 * Pure. `split('/').filter(Boolean)` collapses duplicate and trailing slashes before the
 * chain is built, so a malformed input (`//projects//mymind/`) still yields clean, valid
 * paths — which matters now that `folders_path_format_check` (Task 3) makes a bad path a
 * hard DB failure instead of bad data.
 */
export function folderChainPaths(folderPath: string): string[] {
  const parts = folderPath.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push('/' + parts.slice(0, i + 1).join('/'))
  }
  return out
}

/**
 * Every ancestor folder path of a DOCUMENT path, root-first, filename dropped.
 * '/projects/mymind/wiki/auth.md' → ['/projects', '/projects/mymind', '/projects/mymind/wiki']
 *
 * A document's ancestors are exactly the chain of its parent folder, so this drops the
 * filename and defers to folderChainPaths. Pure. The root is deliberately absent — it is not
 * a folder row.
 */
export function ancestorFolderPaths(docPath: string): string[] {
  const parts = docPath.split('/').filter(Boolean)
  parts.pop() // the filename
  return folderChainPaths('/' + parts.join('/'))
}

/**
 * Record every folder a document path implies.
 *
 * Called from createDoc/updateDoc — the SERVICE, not the HTTP route — because that is the
 * only choke point every writer shares: the documents UI, MCP (save_document, sync_document,
 * move_document, edit_document), capture triage's /input sweep, and ShareX transcriptions all
 * funnel through those two functions. Hooking a route would silently miss most of them.
 *
 * Idempotent: conflicts on the unique path index are ignored.
 */
export async function ensureFolders(docPath: string, tx: Db = useDb()): Promise<void> {
  const paths = ancestorFolderPaths(docPath)
  if (!paths.length) return
  await tx.insert(folders).values(paths.map(path => ({ path }))).onConflictDoNothing()
}
