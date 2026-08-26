import { z } from 'zod'
import type { H3Event } from 'h3'
import type { FolderOpFailure } from '../services/folders'

/**
 * Shared by folder create (`index.post.ts`) and move (`[id].patch.ts`) — a leading slash, no
 * trailing slash, at least one path segment. Factored out so the two routes can't drift apart
 * on what "a valid folder path" means.
 */
export const FOLDER_PATH_SCHEMA = z.string().regex(/^\/(?!.*\/$).+/, 'path must be absolute and have no trailing slash')

/**
 * Validate a folder route's `id` path param as a UUID, throwing the SAME 404 shape the service
 * layer's own not-found errors use (`no folder with id <id>` — see folders.ts's `notFound()`)
 * for anything else — not a distinct validation-error shape, and not a raw Postgres error.
 *
 * Without this, a non-uuid `id` reaches `eq(folders.id, id)` and raises `invalid input syntax
 * for type uuid` — a 500, not a 404. Reachable in practice, not just in theory: the optimistic
 * folder-create path stamps `temp-${crypto.randomUUID()}` ids client-side before the real
 * folder row (and its real uuid) comes back, and the tree's `folderTarget` guard only checks
 * truthiness — so acting on a just-created folder before it settles hits exactly this. A
 * malformed id can never match a real row anyway, so "not found" is the correct outcome either
 * way.
 */
export function requireFolderId(event: H3Event): string {
  const id = getRouterParam(event, 'id')
  if (!id || !z.uuid().safeParse(id).success) {
    throw createError({ statusCode: 404, statusMessage: `no folder with id ${id ?? ''}` })
  }
  return id
}

/**
 * Map a FolderOpFailure onto the HTTP error the folder routes speak. Shared by create and
 * move so the two can never present the same `reason` with a different message — a collision
 * is always "Path already taken: <path>" regardless of which route produced it, even though
 * only moveFolder can return one today (createFolder's only reachable reason is 'invalid').
 *
 * The `default` branch assigns to a `never`-typed const: adding a fourth `FolderOpFailure`
 * reason without updating this function is a compile error, not a silent fall-through to 409.
 */
export function folderOpError(f: FolderOpFailure) {
  switch (f.reason) {
    case 'not-found':
      return createError({ statusCode: 404, statusMessage: f.conflict })
    case 'invalid':
      return createError({ statusCode: 400, statusMessage: f.conflict })
    case 'collision':
      return createError({ statusCode: 409, statusMessage: `Path already taken: ${f.conflict}` })
    default: {
      const exhaustive: never = f.reason
      return createError({ statusCode: 500, statusMessage: `unhandled folder failure reason: ${exhaustive}` })
    }
  }
}
