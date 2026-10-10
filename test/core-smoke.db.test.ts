// Cycle 80: spawns scripts/core-smoke.ts under plain tsx (no Nuxt, no vitest transforms, no
// core-bridge setup) — the step-2 worker's situation. Read-only against the shared dev DB.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('@mymind/core outside Nuxt', () => {
  it('initCore from env → select 1 + a drizzle count through useDb()', () => {
    const out = execFileSync('node_modules/.bin/tsx', ['--env-file-if-exists=.env', 'scripts/core-smoke.ts'], {
      encoding: 'utf8',
      timeout: 60_000
    })
    expect(out).toMatch(/^core-smoke OK select1=1 projects=\d+$/m)
  }, 70_000)
})
