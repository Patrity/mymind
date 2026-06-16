import { describe, it, expect } from 'vitest'
import { projectIdForScope } from '../server/lib/projects/memory-project'

describe('projectIdForScope', () => {
  it('agent scope inherits the session project; user/world are global (null)', () => {
    expect(projectIdForScope('agent', 'p1')).toBe('p1')
    expect(projectIdForScope('user', 'p1')).toBeNull()
    expect(projectIdForScope('world', 'p1')).toBeNull()
    expect(projectIdForScope('agent', null)).toBeNull()
  })
})
