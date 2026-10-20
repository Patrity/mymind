// test/stt-wav-transcode.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { isWav, resolveFfmpegPath, toWav16k } from '@mymind/core/lib/voice/providers/wav-transcode'

function wavBytes(): Uint8Array {
  const b = new Uint8Array(44)
  b.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  b.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return b
}

/** A fake child process: writes `out` to the output path (last arg) then exits with `code`. */
function fakeSpawn(out: Uint8Array, code = 0) {
  return vi.fn((_cmd: string, args: string[]) => {
    if (code === 0) writeFileSync(args[args.length - 1]!, out)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn()
    setTimeout(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code)
    }, 0)
    return child as any
  })
}

describe('isWav', () => {
  it('recognises a RIFF/WAVE header', () => expect(isWav(wavBytes())).toBe(true))
  it('rejects mp3 / caf / short buffers', () => {
    expect(isWav(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(false) // ID3
    expect(isWav(new TextEncoder().encode('caff\0\x01\0\0'))).toBe(false)
    expect(isWav(new Uint8Array([1]))).toBe(false)
  })
})

describe('resolveFfmpegPath', () => {
  it('prefers FFMPEG_PATH when it exists', () => {
    expect(resolveFfmpegPath({ FFMPEG_PATH: '/x/ffmpeg' }, p => p === '/x/ffmpeg')).toBe('/x/ffmpeg')
  })
  it('falls back to Homebrew, then bare ffmpeg on PATH', () => {
    expect(resolveFfmpegPath({ FFMPEG_PATH: '/missing' }, p => p === '/opt/homebrew/bin/ffmpeg')).toBe('/opt/homebrew/bin/ffmpeg')
    expect(resolveFfmpegPath({}, () => false)).toBe('ffmpeg')
  })
})

describe('toWav16k', () => {
  it('passes WAV through untouched without spawning ffmpeg', async () => {
    const spawn = fakeSpawn(new Uint8Array())
    const input = wavBytes()
    const r = await toWav16k(input, { spawn, ffmpegPath: 'ffmpeg' })
    expect(r).toEqual({ audio: input, converted: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('transcodes non-WAV to 16 kHz mono PCM16 WAV', async () => {
    const out = wavBytes()
    const spawn = fakeSpawn(out)
    const r = await toWav16k(new Uint8Array([0x49, 0x44, 0x33]), { spawn, ffmpegPath: '/opt/homebrew/bin/ffmpeg' })
    expect(r.converted).toBe(true)
    expect(Array.from(r.audio)).toEqual(Array.from(out))
    const [cmd, args] = spawn.mock.calls[0]!
    expect(cmd).toBe('/opt/homebrew/bin/ffmpeg')
    expect(args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav']))
  })

  it('fails soft to the original bytes when ffmpeg exits non-zero', async () => {
    const input = new Uint8Array([9, 9, 9])
    const r = await toWav16k(input, { spawn: fakeSpawn(new Uint8Array(), 1), ffmpegPath: 'ffmpeg' })
    expect(r).toEqual({ audio: input, converted: false })
  })

  it('fails soft when ffmpeg is missing (spawn error)', async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn()
      setTimeout(() => child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' })), 0)
      return child
    })
    const input = new Uint8Array([7, 7])
    const r = await toWav16k(input, { spawn: spawn as any, ffmpegPath: 'ffmpeg' })
    expect(r).toEqual({ audio: input, converted: false })
  })
})

function hasFfmpeg(): string | null {
  for (const p of [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', 'ffmpeg']) {
    if (!p) continue
    try { execFileSync(p, ['-version'], { stdio: 'ignore' }); return p } catch { /* next */ }
  }
  return null
}
const ff = hasFfmpeg()

describe.skipIf(!ff)('toWav16k with real ffmpeg', () => {
  it('converts an mp3 to a 16 kHz mono s16 WAV', async () => {
    const mp3 = execFileSync(ff!, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'mp3', 'pipe:1'])
    const r = await toWav16k(new Uint8Array(mp3), { ffmpegPath: ff! })
    expect(r.converted).toBe(true)
    expect(isWav(r.audio)).toBe(true)
    const v = new DataView(r.audio.buffer, r.audio.byteOffset, r.audio.byteLength)
    expect(v.getUint16(22, true)).toBe(1) // channels
    expect(v.getUint32(24, true)).toBe(16000) // sample rate
    expect(v.getUint16(34, true)).toBe(16) // bits per sample
  })
})
