import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

const store = new Map<string, Buffer>()
let lastRow: any = null

vi.mock('../server/utils/storage', () => ({
  storage: () => ({
    put: async (stream: Readable, _hint?: unknown) => {
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(Buffer.from(c))
      const buf = Buffer.concat(chunks)
      const key = 'key-' + store.size
      store.set(key, buf)
      return { key, sha256: 'sha', size: buf.length }
    },
    get: async (key: string) => ({ stream: Readable.from(store.get(key)!) })
  })
}))

vi.mock('../server/db', () => ({
  useDb: () => ({
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          lastRow = { id: 'f1', ...v }
          return [lastRow]
        }
      })
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (lastRow ? [lastRow] : [])
        })
      })
    })
  })
}))

import { saveFile, getFileBytes } from '../server/services/files'

beforeEach(() => {
  store.clear()
  lastRow = null
})

describe('files service', () => {
  it('saveFile stores the blob + returns a ref', async () => {
    const ref = await saveFile(Buffer.from('hello pdf'), 'application/pdf', 'a.pdf')
    expect(ref).toMatchObject({ id: 'f1', mime: 'application/pdf', name: 'a.pdf', size: 9 })
  })

  it('getFileBytes round-trips the stored bytes', async () => {
    await saveFile(Buffer.from('hello pdf'), 'application/pdf', 'a.pdf')
    const got = await getFileBytes('f1')
    expect(got!.bytes.toString()).toBe('hello pdf')
    expect(got!.mime).toBe('application/pdf')
  })

  it('getFileBytes returns null when the row is missing', async () => {
    const got = await getFileBytes('nope')
    expect(got).toBeNull()
  })
})
