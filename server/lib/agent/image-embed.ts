// server/lib/agent/image-embed.ts
// The SERVER owns image embeds in the chat. The model never receives a URL, so it
// cannot show an image that wasn't generated. This strips any /api/images embed the
// model wrote anyway (belt-and-suspenders) and appends the real embed(s).
export interface DisplayImage { id: string; url: string; alt: string }

// matches ![alt](/api/images/...) and [text](/api/images/.../raw) the model might author
const MODEL_IMG_RE = /!?\[[^\]]*\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g

export function applyImageEmbeds(text: string, images: DisplayImage[]): { content: string; appended: string } {
  const stripped = (text ?? '').replace(MODEL_IMG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!images.length) return { content: stripped, appended: '' }
  const sanitize = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 120)
  const embeds = images.map(i => `![${sanitize(i.alt)}](${i.url})`).join('\n\n')
  const appended = (stripped ? '\n\n' : '') + embeds
  return { content: stripped + appended, appended }
}

/**
 * Redact /api/images URLs from prior assistant turns BEFORE the model sees them as
 * history. The server authors image embeds into persisted messages (so the chat renders
 * them), but feeding those URLs back to the model lets it COPY a real URL into a new
 * reply — which streams live as the wrong/old image (and double-renders alongside the
 * server's real embed). Replacing `![alt](/api/images/..)` with `[generated image: alt]`
 * keeps the model's context ("an image of X exists") while removing any URL to copy.
 */
export function redactImageUrlsForModel(text: string): string {
  return (text ?? '')
    .replace(/!\[([^\]]*)\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g, (_m, alt) => alt ? `[generated image: ${alt}]` : '[generated image]')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g, (_m, txt) => txt ? `[image: ${txt}]` : '[image]')
}
