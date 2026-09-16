import { describe, it, expect } from 'vitest'
import { resolveSelectedPreset } from './presets'

const LIST = [
  // Ordered by name, exactly as GET /api/voice/presets returns it (asc(name)) —
  // note the default is NOT first, which is the whole point of this resolution.
  { id: 'bright-man', name: 'Bright, brisk', isDefault: false },
  { id: 'neutral-lowkey', name: 'Neutral, low-key', isDefault: true },
  { id: 'warm-narrator', name: 'Warm narrator', isDefault: false }
]

describe('resolveSelectedPreset', () => {
  it('shows the stored preset when it is in the list', () => {
    expect(resolveSelectedPreset('warm-narrator', LIST)).toBe('warm-narrator')
  })

  it("resolves '' to the DEFAULT preset, not the alphabetically-first one", () => {
    // The server resolves '' to the isDefault row; showing presets[0] would tell the
    // user they are hearing "Bright, brisk" while "Neutral, low-key" is speaking.
    expect(resolveSelectedPreset('', LIST)).toBe('neutral-lowkey')
    expect(resolveSelectedPreset('', LIST)).not.toBe(LIST[0]!.id)
  })

  it('resolves a stored id that matches nothing to the default — the server does the same', () => {
    // Two real ways to get here: the turn was spoken under FALLBACK_PRESET (never listed
    // by /api/voice/presets), or the picked preset has since been deleted.
    expect(resolveSelectedPreset('fallback-neutral-lowkey', LIST)).toBe('neutral-lowkey')
    expect(resolveSelectedPreset('deleted-row', LIST)).toBe('neutral-lowkey')
  })

  it('falls back to the first entry when no preset is flagged default', () => {
    const noDefault = LIST.map(p => ({ ...p, isDefault: false }))
    expect(resolveSelectedPreset('', noDefault)).toBe('bright-man')
  })

  it("selects nothing on an empty list rather than throwing — and never yields a non-empty phantom id", () => {
    // Pre-hydration / a failed fetch. '' as the MODEL value is fine; what reka-ui rejects
    // is an empty-string value on an ITEM, and an empty list has no items.
    expect(resolveSelectedPreset('', [])).toBe('')
    expect(resolveSelectedPreset('warm-narrator', [])).toBe('')
  })
})
