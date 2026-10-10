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

/**
 * The markers below stand in for an attachment that could not be used. Keep this list next to
 * the code that emits them — the resume-path stripper previously knew only about the first,
 * so `[unsupported file: …]` leaked straight through it.
 */
const ATTACHMENT_MARKER = /^\[(?:attachment unavailable|unsupported file)\b[^\]]*\]$/

/**
 * Strip attachment markers from model-facing content.
 *
 * A marker's job is to tell the model, during ONE live turn, that an attachment could not be
 * read. It must never become durable: `ws.ts` flattens parts into
 * `conversation_messages.content`, and `hydrateAttachments` feeds that stored content back in
 * as the `text` argument on every resume. So a marker that reaches storage is replayed on every
 * future turn AND can no longer be filtered — it is now part of a larger text blob rather than
 * its own part. Strip at the persist boundary; the string form also cleans rows written before
 * that was true.
 */
export function withoutAttachmentMarkers(content: string | AgentContentPart[]): string | AgentContentPart[] {
  if (typeof content === 'string') {
    return content.split('\n').filter(l => !ATTACHMENT_MARKER.test(l.trim())).join('\n').trim()
  }
  return content.filter(p => !(p.type === 'text' && ATTACHMENT_MARKER.test(p.text.trim())))
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
