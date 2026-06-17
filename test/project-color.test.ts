import { describe, it, expect } from 'vitest'
import { projectColor, PROJECT_PALETTE } from '../app/utils/project-color'

describe('projectColor', () => {
  it('override wins', () => { expect(projectColor('anything', '#123456')).toBe('#123456') })
  it('is deterministic per slug and a palette member', () => {
    const a = projectColor('mymind'); const b = projectColor('mymind')
    expect(a).toBe(b)
    expect(PROJECT_PALETTE).toContain(a)
  })
  it('distributes (two different slugs need not collide)', () => {
    expect(projectColor('mymind')).not.toBe(projectColor('2d-rpg'))
  })
  it('ignores empty override', () => { expect(PROJECT_PALETTE).toContain(projectColor('x', null)) })
})
