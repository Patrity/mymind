import { desc, eq, isNull, and } from 'drizzle-orm'
import { useDb } from '../db'
import { apiTokens } from '../db/schema'
import { generateToken, hashToken, tokenLastFour } from '../utils/api-token'
import { publishChange } from '../utils/live-bus'
import type { ApiTokenDTO } from '../../shared/types/api-token'

function toDTO(r: typeof apiTokens.$inferSelect): ApiTokenDTO {
  return {
    id: r.id,
    name: r.name,
    lastFour: r.lastFour,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null
  }
}

/** All tokens, newest first. Never returns the hash. */
export async function listTokens(): Promise<ApiTokenDTO[]> {
  const rows = await useDb().select().from(apiTokens).orderBy(desc(apiTokens.createdAt))
  return rows.map(toDTO)
}

/**
 * Mint a token. Returns the DTO plus the plaintext token EXACTLY ONCE —
 * the plaintext is never persisted or logged (only its sha256 hash + last 4).
 */
export async function createToken(name: string): Promise<ApiTokenDTO & { token: string }> {
  const trimmed = name.trim()
  if (!trimmed) {
    throw createError({ statusCode: 400, statusMessage: 'Token name is required' })
  }
  const token = generateToken()
  const [row] = await useDb().insert(apiTokens).values({
    name: trimmed,
    tokenHash: hashToken(token),
    lastFour: tokenLastFour(token)
  }).returning()
  publishChange({ resource: 'apiToken', action: 'created', id: row!.id })
  return { ...toDTO(row!), token }
}

/** Soft-revoke (set revoked_at, keep the row). Idempotent; 404 on unknown id. */
export async function revokeToken(id: string): Promise<ApiTokenDTO> {
  const db = useDb()
  const [existing] = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).limit(1)
  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: 'Token not found' })
  }
  if (existing.revokedAt) {
    return toDTO(existing) // already revoked — idempotent
  }
  const [row] = await db.update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning()
  publishChange({ resource: 'apiToken', action: 'updated', id })
  return toDTO(row ?? existing)
}
