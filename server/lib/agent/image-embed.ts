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
