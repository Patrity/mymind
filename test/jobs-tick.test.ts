// Pure unit test — no DB. wakeRequestFor is a pure function of (slug, jobId, spec, prompt);
// the DB-backed scheduling behaviour around it lives in test/jobs-tick.db.test.ts.
import { describe, it, expect } from 'vitest'
import { wakeRequestFor } from '@mymind/core/lib/agent/jobs/tick'
import type { JobSpec } from '@mymind/core/lib/agent/jobs/parse'

const spec: JobSpec = {
  trigger: { kind: 'every', expr: '30m' },
  timezone: 'UTC',
  activeHours: null,
  model: 'default',
  thread: 'main',
  context: 'full',
  deliver: ['auto'],
  enabled: true,
  filter: null,
  toolsets: [],
  body: 'Do the thing.'
}

describe('wakeRequestFor', () => {
  it('carries job toolsets onto the wake request only when declared', () => {
    expect(wakeRequestFor('s', 'j', { ...spec, toolsets: ['images'] }, 'p').toolsets).toEqual(['images'])
    expect(wakeRequestFor('s', 'j', { ...spec, toolsets: [] }, 'p')).not.toHaveProperty('toolsets')
  })
})
