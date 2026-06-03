import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import type { StorageDriver } from './index'

/**
 * Local-disk storage driver. Blobs are content-addressed by sha256
 * and laid out as `<root>/<sha[0:2]>/<sha>` for fan-out.
 *
 * `put` streams to a tmp file while accumulating the hash + size in
 * a measuring transform — single pass, no buffering. On dedup hit
 * (final path already exists) the tmp is discarded; otherwise we
 * rename it into place atomically (same FS).
 */
export class LocalDriver implements StorageDriver {
  constructor(private root: string) {}

  private pathFor(sha: string) {
    return join(this.root, sha.slice(0, 2), sha)
  }

  async put(input: Readable) {
    mkdirSync(this.root, { recursive: true })
    const tmp = join(
      this.root,
      `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const hash = createHash('sha256')
    let size = 0
    const measure = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk)
        size += chunk.length
        cb(null, chunk)
      }
    })
    await pipeline(input, measure, createWriteStream(tmp))
    const sha = hash.digest('hex')
    const final = this.pathFor(sha)
    mkdirSync(dirname(final), { recursive: true })
    if (existsSync(final)) {
      // dedup hit: drop the tmp
      unlinkSync(tmp)
    } else {
      renameSync(tmp, final)
    }
    return { key: sha, sha256: sha, size }
  }

  async get(key: string) {
    const p = this.pathFor(key)
    if (!existsSync(p)) throw new Error(`Not found: ${key}`)
    return { stream: createReadStream(p), size: statSync(p).size }
  }

  async delete(key: string) {
    const p = this.pathFor(key)
    if (existsSync(p)) unlinkSync(p)
  }

  async presignGet(_key: string, _ttl: number) { return null }

  async exists(sha256: string) {
    return existsSync(this.pathFor(sha256)) ? sha256 : null
  }
}
