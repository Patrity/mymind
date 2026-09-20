// app/lib/voice/mic.ts
//
// Mirrors the live agent's mic acquisition (app/composables/useVoice.ts:330-346) so the
// studio records through the microphone the user actually chose. Before this, the
// reference-clip recorder called getUserMedia({ audio: true }) and the setting did nothing.
//
// This deliberately duplicates useVoice's logic rather than useVoice importing from here:
// streaming speech through a VAD and recording a one-off clip are different jobs, and
// unifying the two paths was explicitly ruled out for this cycle's scope.

export const BASE_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: false }

/** '' means "let the OS choose". An explicit id is `exact` so a stale selection fails
 *  loudly rather than silently recording from the wrong microphone. */
export function micConstraints(deviceId: string): MediaTrackConstraints {
  return deviceId ? { ...BASE_AUDIO, deviceId: { exact: deviceId } } : { ...BASE_AUDIO }
}

/** A device unplugged since it was chosen throws OverconstrainedError. Anything else —
 *  a permission denial above all — must reach the user rather than being retried away. */
export function isStaleDeviceError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'OverconstrainedError'
}
