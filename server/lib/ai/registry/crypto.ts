// server/lib/ai/registry/crypto.ts
// AES-256-GCM for provider API keys. The key is derived from BETTER_AUTH_SECRET
// via HKDF-SHA256 (so no new required env), or taken from CONFIG_ENC_KEY
// (raw 32-byte base64) when set. Stored format: base64(iv(12) | tag(16) | ct).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

function key(): Buffer {
  const override = process.env.CONFIG_ENC_KEY
  if (override) {
    const raw = Buffer.from(override, 'base64')
    if (raw.length !== 32) throw new Error('CONFIG_ENC_KEY must be 32 bytes (base64)')
    return raw
  }
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to encrypt AI config secrets')
  // HKDF → 32 bytes. Fixed salt/info: deterministic per BETTER_AUTH_SECRET.
  return Buffer.from(hkdfSync('sha256', secret, 'mymind-ai-config', 'ai-config-key', 32))
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
