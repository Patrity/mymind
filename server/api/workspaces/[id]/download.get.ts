// Cycle 82 Task 3: download a workspace file (≤ 100 MB, else 413). The web never opens the file: the
// worker reads it inside the sandbox in ~720 KB chunks over the command bus (each chunk's row is
// deleted once read), streamed out as they arrive. A file that changes mid-download aborts it.
// `?check=1` (fix round 1, M4) runs only the size probe and answers JSON — the UI calls it first, so a
// 413 / 504 / 404 shows as a toast in the app instead of a browser-level "download failed".
import { askWorker, requirePath, requireWorkspace } from '../../../utils/workspaces-http'
import { CHUNK_BYTES, DOWNLOAD_MAX_BYTES } from '@mymind/core/lib/sandbox/paths'

type Chunk = { size: number; mtimeNs: string; data: string }

export default defineEventHandler(async (event) => {
  const path = requirePath(event)
  const ws = await requireWorkspace(event)
  const chunk = (offset: number, length: number) =>
    askWorker('workspace-view', { op: 'chunk', workspaceId: ws.id, path, offset, length }, { discardResult: true }) as Promise<Chunk>
  const first = await chunk(0, 0)
  if (first.size > DOWNLOAD_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'File too large', data: { message: `${path} is ${first.size} bytes; downloads are limited to ${DOWNLOAD_MAX_BYTES} bytes (100 MB).` } })
  }
  const name = (path.split('/').pop() || 'download').replace(/[^\w.\- ]+/g, '_').slice(0, 200)
  if (getQuery(event).check !== undefined) return { ok: true, size: first.size, name }
  setResponseHeaders(event, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': first.size,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store'
  })
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (offset >= first.size) { ctrl.close(); return }
      try {
        const c = await chunk(offset, Math.min(CHUNK_BYTES, first.size - offset))
        if (c.size !== first.size || c.mtimeNs !== first.mtimeNs) throw new Error(`${path} changed during the download`)
        const bytes = Buffer.from(c.data, 'base64')
        if (!bytes.length) throw new Error(`${path} ended early`)
        offset += bytes.length
        ctrl.enqueue(new Uint8Array(bytes))
      } catch (err) {
        ctrl.error(err)
      }
    }
  })
  return sendStream(event, stream)
})
