import type { AgentContentPart } from './run'
import { renderPdfToImages } from './pdf-render'

export interface AttachmentRef { id: string; kind: 'image' | 'file'; mime: string; name?: string }

const TEXT_LIKE = /^text\//
const TEXT_LIKE_EXACT = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-yaml',
  'application/x-sh', 'application/csv', 'application/markdown'
])
export function isTextLikeMime(mime: string): boolean {
  return TEXT_LIKE.test(mime) || TEXT_LIKE_EXACT.has(mime)
}

type ReadBytes = (a: AttachmentRef) => Promise<{ bytes: Buffer; mime: string } | null>
type RenderPdf = (bytes: Buffer) => Promise<{ bytes: Buffer; mime: 'image/webp' }[]>

export async function buildUserMessageParts(
  text: string,
  attachments: AttachmentRef[],
  readBytes: ReadBytes,
  renderPdf: RenderPdf = (b) => renderPdfToImages(b)
): Promise<string | AgentContentPart[]> {
  if (!attachments.length) return text
  const parts: AgentContentPart[] = []
  if (text) parts.push({ type: 'text', text })
  const note = (name?: string) => parts.push({ type: 'text', text: `[attachment unavailable${name ? `: ${name}` : ''}]` })

  for (const a of attachments) {
    const got = await readBytes(a).catch(() => null)
    if (!got) { note(a.name); continue }
    const imagePart = (mime: string, bytes: Buffer) =>
      parts.push({ type: 'image', image: `data:${mime};base64,${bytes.toString('base64')}`, mediaType: mime })

    if (a.kind === 'image') { imagePart(got.mime, got.bytes); continue }
    // file:
    if (got.mime === 'application/pdf') {
      const pages = await renderPdf(got.bytes).catch(() => [])
      if (!pages.length) { note(a.name); continue }
      for (const pg of pages) imagePart(pg.mime, pg.bytes)
    } else if (isTextLikeMime(got.mime)) {
      parts.push({ type: 'text', text: `[file ${a.name ?? a.id}]:\n${got.bytes.toString('utf8')}` })
    } else {
      parts.push({ type: 'text', text: `[unsupported file: ${a.name ?? a.id}]` })
    }
  }
  return parts.length ? parts : text
}
