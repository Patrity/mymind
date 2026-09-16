// app/lib/voice/wav-encode.ts
// Mic recording -> the WAV that POST /api/voice/reference will accept.
//
// MediaRecorder produces webm/opus, and the reference route rejects anything that is not
// RIFF/WAVE outright (wavDurationMs throws, 400 "Reference must be a WAV file"). So a
// recorded clip is decoded through an AudioContext and re-encoded here. Mono 16-bit PCM,
// because that is what wavDurationMs measures and what Breeze wants.
//
// Kept out of the component so the encoder can be round-tripped against the server's own
// header parser in a unit test — the header is the part that fails silently.

/**
 * Sample rate + PCM payload size of a canonical 44-byte-header WAV — which is what the
 * server's `pcmToWav` writes and what `encodeWav` below writes. Used to size a download
 * against the text that produced it (see diagnoseTruncation): a render that stops early
 * arrives as 200 OK with a short body and no error anywhere to read.
 *
 * Returns null for anything that is not RIFF/WAVE. Falls back to "everything after the
 * header" when the `data` chunk is not at the canonical offset, rather than reading an
 * unrelated u32 as a length.
 */
export function readWavInfo(bytes: Uint8Array): { sampleRate: number, dataBytes: number } | null {
  if (bytes.byteLength < 44) return null
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = v.getUint32(24, true)
  const canonical = ascii(36, 40) === 'data'
  const declared = canonical ? v.getUint32(40, true) : bytes.byteLength - 44
  return { sampleRate, dataBytes: Math.max(0, Math.min(declared, bytes.byteLength - 44)) }
}

/** Mix an AudioBuffer's channels down to one, without needing a real AudioBuffer in tests. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0]
  if (!first) return new Float32Array(0)
  if (channels.length === 1) return first
  const out = new Float32Array(first.length)
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (const ch of channels) sum += ch[i] ?? 0
    out[i] = sum / channels.length
  }
  return out
}

/** 16-bit mono PCM WAV from Float32 samples in [-1, 1].
 *  The `<ArrayBuffer>` on the return type matters: bare `Uint8Array` widens to
 *  `Uint8Array<ArrayBufferLike>`, which is not a `BlobPart` — so the result could not be
 *  wrapped in the Blob that gets posted to /api/voice/reference. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true) // byte rate = rate * channels * bytes-per-sample
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] ?? 0))
    v.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7FFF, true)
    offset += 2
  }
  return new Uint8Array(buf)
}
