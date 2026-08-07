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

// The strip/collapse chain applied to EVERY assistant turn before it is persisted. Factored
// out so `sanitizedOffset` below cannot drift from what `applyImageEmbeds` actually produces.
// Whitespace-only, position-independent: applying it to a prefix gives the same result as
// applying it to the whole string and taking that prefix — except across the seam (see below).
function collapse(text: string): string {
  return (text ?? '')
    .replace(MODEL_IMG_RE, '').replace(STRAY_IMG_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
}

/**
 * Where a PREFIX of the streamed assistant text lands inside the PERSISTED (sanitized)
 * content — i.e. the offset a tool-call record must carry.
 *
 * `applyImageEmbeds` runs unconditionally on the final text (even with no images) and
 * trims/collapses whitespace, so a raw `assistantText.length` offset indexes a string that no
 * longer exists: any collapse before the offset shifts it, and resume then splits the bubble
 * mid-word ("Okay. D" | chip | "one."). Recording `sanitizedOffset(textSoFar)` instead makes
 * the offset an index into the string that is actually stored.
 *
 * Only the START is trimmed: the full text's leading whitespace is also the prefix's leading
 * whitespace, but the full text's TRAILING trim applies to the end of the whole reply, not to
 * this boundary — trimming the prefix's tail would push every chip one word to the left.
 *
 * Residual 1 — whitespace straddle: when a collapse spans the boundary (prefix ends "a  ",
 * suffix starts " b" → persisted "a b") the split can land one character either side of the
 * collapsed run. That is inside whitespace, so the rendered text stays word-correct; resume
 * additionally clamps to `content.length`, which absorbs the whole-text trailing trim.
 *
 * Residual 2 — pattern straddle, and this one is NOT word-safe: `collapse` also strips image
 * markdown, so a marker that is half-typed at the boundary and complete by the end of the reply
 * shrinks by its whole length rather than by a space. `sanitizedOffset('a ![imag')` is 8 while
 * `sanitizedOffset('a ![image]b')` is 3 — so offsets are NOT monotonic across a turn, and the
 * split can land mid-word. `buildResumeTranscript` guards the consequence with
 * `cursor = Math.max(cursor, at)`, which prevents re-emitting text but cannot recover the exact
 * position. Rare: it needs a tool call to fire while the model is part-way through a marker.
 */
export function sanitizedOffset(text: string): number {
  return collapse(text).trimStart().length
}

export function applyImageEmbeds(text: string, images: DisplayImage[]): { content: string; appended: string } {
  const stripped = collapse(text).trim()
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
