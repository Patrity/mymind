import { describe, it, expect } from 'vitest'
import { classifyFrame } from '../server/lib/voice/frames'

const enc = (s: string) => new TextEncoder().encode(s)
const wav = () => {
  const b = new Uint8Array(64)
  b.set([0x52, 0x49, 0x46, 0x46]) // 'RIFF'
  return b
}

describe('classifyFrame', () => {
  it('classifies JSON text frames as control', () => {
    expect(classifyFrame('{"type":"interrupt"}')).toEqual({ kind: 'control', msg: { type: 'interrupt' } })
  })

  it('classifies JSON delivered as bytes as control (crossws@0.3.5 node adapter drops isBinary)', () => {
    expect(classifyFrame(enc('{"type":"voice","provider":"kokoro","voice":"af_heart"}'))).toEqual({
      kind: 'control',
      msg: { type: 'voice', provider: 'kokoro', voice: 'af_heart' },
    })
  })

  it('classifies RIFF/WAV bytes as audio', () => {
    const f = classifyFrame(wav())
    expect(f.kind).toBe('audio')
    if (f.kind === 'audio') expect(f.bytes.length).toBe(64)
  })

  it('Buffer subclass of Uint8Array works for both paths', () => {
    expect(classifyFrame(Buffer.from('{"type":"interrupt"}')).kind).toBe('control')
    expect(classifyFrame(Buffer.from(wav())).kind).toBe('audio')
  })

  it('ignores garbage: non-WAV non-JSON bytes, empty frames, malformed JSON, JSON without type', () => {
    expect(classifyFrame(new Uint8Array([1, 2, 3, 4])).kind).toBe('ignore')
    expect(classifyFrame(new Uint8Array(0)).kind).toBe('ignore')
    expect(classifyFrame('not json').kind).toBe('ignore')
    expect(classifyFrame('{"no":"type"}').kind).toBe('ignore')
    expect(classifyFrame(enc('{broken')).kind).toBe('ignore')
  })
})
