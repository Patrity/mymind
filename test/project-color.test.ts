import { describe, it, expect } from 'vitest'
import { projectColor, PROJECT_PALETTE, NEUTRAL_COLOR } from '../app/utils/project-color'

describe('projectColor', () => {
  it('override wins', () => { expect(projectColor('anything', '#123456')).toBe('#123456') })
  it('defaults to neutral grey when no override', () => { expect(projectColor('mymind')).toBe(NEUTRAL_COLOR) })
  it('treats empty override as neutral grey', () => { expect(projectColor('x', null)).toBe(NEUTRAL_COLOR) })
  it('palette has 14 entries', () => { expect(PROJECT_PALETTE).toHaveLength(14) })
})
