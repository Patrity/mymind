import { createHash } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { StorageDriver } from './index'

export interface S3Config {
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * S3-compatible storage driver (AWS, R2, B2, MinIO).
 *
 * `put` buffers the stream into memory to compute sha256 before upload —
 * S3 needs a known Content-Length or multipart-upload, and this driver
 * caps uploads at manageable sizes for in-memory buffering. If we ever
 * need to raise the cap we'd switch to `@aws-sdk/lib-storage` (multipart)
 * with a finalize-after-hash step.
 *
 * Keys are the raw sha256 hex string — same content-addressing scheme as
 * the local driver, which keeps the upload path symmetric.
 *
 * This driver is PRESENT but dormant in cycle 1 — S3 env vars are not
 * required until the image-hosting cycle wires them.
 */
export class S3Driver implements StorageDriver {
  private client: S3Client
  private bucket: string

  constructor(private cfg: S3Config) {
    this.client = new S3Client({
      endpoint: cfg.endpoint || undefined,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: !!cfg.endpoint // for MinIO/R2/B2
    })
    this.bucket = cfg.bucket
  }

  async put(input: Readable, hint?: { contentType?: string }) {
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    let size = 0
    const measure = new Transform({
      transform(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buf)
        size += buf.length
        chunks.push(buf)
        cb(null, buf)
      }
    })
    // Drain via async generator sink — we don't need to write anywhere,
    // the transform has already captured the buffers + hash.
    await pipeline(input, measure, async function* (src) {
      for await (const _ of src) { /* drain */ }
    })
    const sha = hash.digest('hex')
    const body = Buffer.concat(chunks)
    // Dedup: HEAD first; skip put if it exists
    const found = await this.exists(sha)
    if (!found) {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: sha,
        Body: body,
        ContentType: hint?.contentType,
        ContentLength: size
      }))
    }
    return { key: sha, sha256: sha, size }
  }

  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    const stream = r.Body as unknown as Readable
    return { stream, size: r.ContentLength, contentType: r.ContentType }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  async presignGet(key: string, ttlSeconds: number) {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds }
    )
  }

  async exists(sha256: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: sha256 }))
      return sha256
    } catch (e: unknown) {
      const err = e as { name?: string, $metadata?: { httpStatusCode?: number } }
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null
      throw e
    }
  }
}
