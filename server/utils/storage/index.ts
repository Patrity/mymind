import type { Readable } from 'node:stream'
import { LocalDriver } from './local'
import { S3Driver } from './s3'

export interface StorageDriver {
  put(stream: Readable, hint?: { contentType?: string }): Promise<{ key: string, sha256: string, size: number }>
  get(key: string): Promise<{ stream: Readable, contentType?: string, size?: number }>
  delete(key: string): Promise<void>
  presignGet(key: string, ttlSeconds: number): Promise<string | null>
  exists(sha256: string): Promise<string | null> // returns existing key if dedup hit, else null
}

let _driver: StorageDriver | null = null

/**
 * Returns the configured storage driver singleton.
 *
 * Driver is selected via `runtimeConfig.storageDriver`:
 *   - 'local' (default): files stored under `runtimeConfig.storageLocalDir`
 *   - 's3': S3-compatible object storage via `runtimeConfig.storageS3.*`
 *
 * In cycle 1, only the local driver is exercised. The S3 driver is present
 * and compiles but is dormant — S3 env vars are wired in the image-hosting cycle.
 */
export function storage(): StorageDriver {
  if (_driver) return _driver
  const cfg = useRuntimeConfig()
  if (cfg.storageDriver === 's3') {
    const s3 = cfg.storageS3 as {
      endpoint?: string
      region: string
      bucket: string
      accessKeyId: string
      secretAccessKey: string
    }
    if (!s3?.bucket || !s3?.accessKeyId || !s3?.secretAccessKey) {
      throw new Error('S3 storage driver selected but S3 config is incomplete. Set STORAGE_S3_* env vars.')
    }
    _driver = new S3Driver({
      endpoint: s3.endpoint,
      region: s3.region ?? 'auto',
      bucket: s3.bucket,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey
    })
  } else {
    _driver = new LocalDriver(cfg.storageLocalDir as string)
  }
  return _driver
}

/** Reset singleton — used in tests. */
export function _resetStorage() { _driver = null }
