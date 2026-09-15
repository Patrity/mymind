// app/lib/voice/presets.ts
// Pure preset-picker resolution, kept out of the component so it's testable without
// mounting a slideover (same reasoning as devices.ts for mics and messages.ts for WS frames).

/** Minimal shape of VoicePresetDTO this module needs — lets tests build plain objects. */
export interface PresetLike { id: string; isDefault: boolean }

/**
 * Which preset the picker should show as selected, given the cookie's `presetId` and the
 * list from GET /api/voice/presets.
 *
 * The control must never claim a voice that is not the one speaking. Two ways that goes
 * wrong if you just read the cookie:
 *
 *  - `''` means "the server's default preset", and so does an id the server cannot find
 *    (resolvePreset). The list is ordered by NAME, so `presets[0]` is generally NOT the
 *    default — showing it would tell the user they are hearing a voice they are not.
 *  - A stored id can be absent from the list for two real reasons: the turn was spoken
 *    under FALLBACK_PRESET, which `listPresets` deliberately never returns, or the preset
 *    was deleted after being picked. Both resolve to the default server-side, so the
 *    picker must follow rather than display a dangling id.
 *
 * Preference order: the stored id if it is really in the list → the `isDefault` entry →
 * the first entry → '' (nothing selected). '' is only ever returned for an EMPTY list,
 * which has no items — reka-ui's USelectMenu rejects an empty-string value on an *item*,
 * not on the model.
 */
export function resolveSelectedPreset(storedId: string, presets: PresetLike[]): string {
  if (storedId && presets.some(p => p.id === storedId)) return storedId
  return presets.find(p => p.isDefault)?.id ?? presets[0]?.id ?? ''
}
