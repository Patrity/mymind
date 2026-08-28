// app/lib/voice/devices.ts
// Pure mapping of MediaDeviceInfo audioinput entries onto microphone-picker
// items, kept out of the component so it's testable without a browser/mic
// permission dance (same reasoning as messages.ts for WS frames).

/** Sentinel for "no deviceId constraint" (cookie value ''). reka-ui's
 *  USelectMenu rejects an empty-string item value, so '' round-trips through
 *  this non-empty sentinel — same pattern as the model picker's DEFAULT_MODEL
 *  (Toolbar.vue / agent/index.vue). */
export const DEFAULT_MIC = '__default__'

export interface MicOption { label: string; value: string }

/** Minimal shape of MediaDeviceInfo this module needs — lets tests build
 *  plain objects instead of the real (method-bearing) browser interface. */
export interface MicDeviceLike { deviceId: string; label: string }

/**
 * Maps enumerateDevices() audioinput entries onto picker items, always
 * leading with "System default". Labels are EMPTY until mic permission has
 * been granted at least once — a browser privacy rule, not a bug — so a
 * blank label falls back to a stable positional name ("Microphone N") rather
 * than presenting a list of blanks.
 */
export function buildMicOptions(inputs: MicDeviceLike[]): MicOption[] {
  return [
    { label: 'System default', value: DEFAULT_MIC },
    ...inputs.map((d, i) => ({ label: d.label || `Microphone ${i + 1}`, value: d.deviceId }))
  ]
}

/** Stored cookie value ('' | deviceId) → USelectMenu item value. */
export function micIdToSelectValue(micDeviceId: string): string {
  return micDeviceId || DEFAULT_MIC
}

/** USelectMenu item value → stored cookie value ('' | deviceId). */
export function selectValueToMicId(value: string): string {
  return value === DEFAULT_MIC ? '' : value
}

/**
 * True if the stored device id is still among the current input list ('' —
 * system default — is always "available"). A device unplugged since it was
 * chosen no longer appears in enumerateDevices(); callers use this to
 * proactively fall back to the default and clear the stale id when the list
 * refreshes, rather than waiting for getUserMedia to throw
 * OverconstrainedError at connect time.
 */
export function isMicIdAvailable(micDeviceId: string, inputs: MicDeviceLike[]): boolean {
  return micDeviceId === '' || inputs.some(d => d.deviceId === micDeviceId)
}
