import { createHash } from 'node:crypto'

/** The body hash both sides compare. Body only — frontmatter is a separate column and is never hashed. */
export function hashBody(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export type SyncTarget = { id: string, contentHash: string | null }

export type SyncDecision =
  | { kind: 'create' }
  | { kind: 'adopt', id: string }
  | { kind: 'unchanged', id: string }
  | { kind: 'write', id: string, expected: string | null }
  | { kind: 'error', error: 'not_found' | 'expected_hash_required' | 'adopt_conflict' | 'hash_mismatch' }

/**
 * Decide what a sync should do. Pure: the caller resolves `target` from the DB first.
 *
 * Fails closed — every divergent path needs either a matching `expected_hash` or an explicit
 * `force`. A first sync must never silently clobber a doc that was edited in the MyMind UI.
 */
export function decideSync(
  input: { id?: string, expectedHash?: string, force?: boolean },
  incomingHash: string,
  target: SyncTarget | null
): SyncDecision {
  if (!target) return input.id ? { kind: 'error', error: 'not_found' } : { kind: 'create' }

  // A no-op is a no-op regardless of force — never write, never emit a change event.
  if (target.contentHash === incomingHash) {
    return input.id ? { kind: 'unchanged', id: target.id } : { kind: 'adopt', id: target.id }
  }

  if (input.force) return { kind: 'write', id: target.id, expected: null }
  if (!input.expectedHash) {
    return { kind: 'error', error: input.id ? 'expected_hash_required' : 'adopt_conflict' }
  }
  if (input.expectedHash !== target.contentHash) return { kind: 'error', error: 'hash_mismatch' }
  return { kind: 'write', id: target.id, expected: input.expectedHash }
}
