import { createHash, randomBytes } from 'node:crypto'

export function generateToken(): string {
  return 'mm_' + randomBytes(24).toString('base64url')
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
