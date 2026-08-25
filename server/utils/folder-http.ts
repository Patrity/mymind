import type { FolderOpFailure } from '../services/folders'

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
