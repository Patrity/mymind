// Final review (T7 deferred minor): queue.ts ↔ channels/inbound.ts must not import each other
// statically — inbound.ts imports `enqueue` from queue.ts, so queue.ts reaches catchUpTick through
// a dynamic import inside workerTick. A static import back would make load order matter.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

describe('queue.ts ↔ inbound.ts import cycle', () => {
  it('inbound.ts imports queue.ts statically; queue.ts reaches inbound.ts only via import()', () => {
    const queue = readFileSync('server/lib/agent/runtime/queue.ts', 'utf8')
    const inbound = readFileSync('server/lib/channels/inbound.ts', 'utf8')
    expect(inbound).toMatch(/^import \{[^}]*\benqueue\b[^}]*\} from '\.\.\/agent\/runtime\/queue'/m)
    expect(queue).not.toMatch(/^import [^;]*from '\.\.\/\.\.\/channels\/inbound'/m)
    expect(queue).toMatch(/await import\('\.\.\/\.\.\/channels\/inbound'\)/)
  })
})
