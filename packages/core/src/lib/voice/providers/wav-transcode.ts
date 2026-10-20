// packages/core/src/lib/voice/providers/wav-transcode.ts
//
// The STT backend (audio.cpp Parakeet) decodes WAV only. Browser voice and reference clips
// already arrive as WAV; iMessage voice memos do not (BlueBubbles hands back MP3/AAC/CAF).
// Anything that is not WAV is transcoded to 16 kHz mono PCM16 WAV with ffmpeg before upload.
//
// Files, not pipes, on both sides: m4a/CAF can keep their index at the end of the file (needs a
// seekable input), and a WAV written to a pipe carries placeholder size fields some decoders reject.
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Spawn = (cmd: string, args: string[]) => {
  on(ev: 'close', cb: (code: number | null) => void): unknown
  on(ev: 'error', cb: (err: Error) => void): unknown
  stderr?: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals | number): unknown
}

const HOMEBREW_FFMPEG = '/opt/homebrew/bin/ffmpeg'
const TIMEOUT_MS = 60_000

/** RIFF....WAVE header. */
export function isWav(b: Uint8Array): boolean {
  return b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45
}

/** FFMPEG_PATH if it exists, else Homebrew's ffmpeg, else bare `ffmpeg` (PATH lookup). */
export function resolveFfmpegPath(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string {
  const fromEnv = env.FFMPEG_PATH?.trim()
  if (fromEnv && exists(fromEnv)) return fromEnv
  if (exists(HOMEBREW_FFMPEG)) return HOMEBREW_FFMPEG
  return 'ffmpeg'
}

/**
 * Returns WAV bytes ready for the STT backend. WAV input is passed through untouched. On any
 * ffmpeg failure (missing binary, undecodable input, timeout) the ORIGINAL bytes come back with
 * `converted: false`, so the caller uploads what it had — never worse than before.
 */
export async function toWav16k(
  audio: Uint8Array,
  deps: { spawn?: Spawn; ffmpegPath?: string; signal?: AbortSignal } = {}
): Promise<{ audio: Uint8Array; converted: boolean }> {
  if (isWav(audio)) return { audio, converted: false }
  const spawn = deps.spawn ?? (nodeSpawn as unknown as Spawn)
  const ffmpeg = deps.ffmpegPath ?? resolveFfmpegPath()
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(tmpdir(), 'mymind-stt-'))
    const inPath = join(dir, 'in.bin')
    const outPath = join(dir, 'out.wav')
    await writeFile(inPath, audio)
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inPath,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', outPath]
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(ffmpeg, args)
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, TIMEOUT_MS)
      const onAbort = () => { child.kill('SIGKILL'); reject(new Error('aborted')) }
      deps.signal?.addEventListener('abort', onAbort, { once: true })
      child.stderr?.resume?.()
      child.on('error', (err) => { clearTimeout(timer); deps.signal?.removeEventListener('abort', onAbort); reject(err) })
      child.on('close', (c) => { clearTimeout(timer); deps.signal?.removeEventListener('abort', onAbort); resolve(c) })
    })
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`)
    const out = new Uint8Array(await readFile(outPath))
    if (!isWav(out)) throw new Error('ffmpeg produced no WAV')
    return { audio: out, converted: true }
  } catch (err) {
    console.warn('[stt] WAV transcode failed, uploading original bytes:', err instanceof Error ? err.message : err)
    return { audio, converted: false }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
