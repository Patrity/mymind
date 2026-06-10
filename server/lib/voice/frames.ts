// server/lib/voice/frames.ts
// Classify incoming voice-WS frames by CONTENT, not transport type: nitro's
// crossws@0.3.5 node adapter drops the ws `isBinary` flag, so TEXT frames reach
// the handler as Buffers and `typeof rawData === 'string'` cannot discriminate.
// Misrouted JSON control frames were being fed to Whisper as audio (HTTP 415).
// Our audio frames are always RIFF/WAV (client floatToWav); controls are JSON.

export type Frame =
  | { kind: 'control'; msg: { type: string; [k: string]: unknown } }
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'ignore' }

export function classifyFrame(raw: string | Uint8Array): Frame {
  if (typeof raw === 'string') return parseControl(raw)
  if (raw.length >= 4 && raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46) {
    return { kind: 'audio', bytes: raw } // 'RIFF'
  }
  if (raw.length && raw[0] === 0x7b) return parseControl(new TextDecoder().decode(raw)) // '{'
  return { kind: 'ignore' }
}

function parseControl(text: string): Frame {
  try {
    const msg = JSON.parse(text) as { type?: unknown }
    return msg && typeof msg === 'object' && typeof msg.type === 'string'
      ? { kind: 'control', msg: msg as { type: string } }
      : { kind: 'ignore' }
  } catch {
    return { kind: 'ignore' }
  }
}
