// server/lib/agent/image-embed.ts
// The SERVER owns image embeds in the chat. The model never receives a URL, so it
// cannot show an image that wasn't generated. This strips any /api/images embed the
// model wrote anyway (belt-and-suspenders) and appends the real embed(s).
export interface DisplayImage { id: string; url: string; alt: string }

// matches ![alt](/api/images/...) and [text](/api/images/.../raw) the model might author
const MODEL_IMG_RE = /!?\[[^\]]*\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g
// A bare "[image]" / "![image]" placeholder the model may copy from its history. It is an
// internal history marker, never a valid reply — strip it from the OUTGOING text so a slipped
// placeholder never reaches the user, even on a turn that called no image tool (turnImages empty).
const STRAY_IMG_MARKER_RE = /!?\[image\]/gi

export function applyImageEmbeds(text: string, images: DisplayImage[]): { content: string; appended: string } {
  const stripped = (text ?? '').replace(MODEL_IMG_RE, '').replace(STRAY_IMG_MARKER_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
  if (!images.length) return { content: stripped, appended: '' }
  const sanitize = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 120)
  const embeds = images.map(i => `![${sanitize(i.alt)}](${i.url})`).join('\n\n')
  const appended = (stripped ? '\n\n' : '') + embeds
  return { content: stripped + appended, appended }
}

/**
 * Redact server-authored /api/images embeds from prior assistant turns BEFORE the model sees
 * them as history. Feeding those embeds back lets the model COPY them into a new reply instead
 * of calling the tool. We REMOVE the embed entirely — leaving nothing to imitate.
 */
export function redactImageUrlsForModel(text: string): string {
  // REMOVE the embed (empty), leaving the model's own prose. Earlier versions replaced it with
  // `[generated image: <alt>]` and then `[image]` — but the model copied THOSE markers verbatim
  // as its reply on the next (edit) turn and skipped the tool call ("[image]" with no render).
  // The only truly non-imitable marker is NOTHING: the model's prose ("here's Travis") + the
  // IMAGES prompt rule (edit_image targets the most recent image) carry the context; the image
  // renders from the tool result's display channel. `applyImageEmbeds` strips any stray `[image]`
  // the model still emits as a belt-and-suspenders backstop.
  return (text ?? '')
    .replace(/!?\[[^\]]*\]\((?:https?:\/\/[^)]*)?\/api\/images\/[^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}
