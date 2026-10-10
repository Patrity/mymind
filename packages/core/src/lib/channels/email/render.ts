// server/lib/channels/email/render.ts
// Markdown -> HTML for the email channel body. Two independent layers keep the output inert:
//  1. `renderEmail` never passes raw HTML from the source through: the marked renderer's
//     `html()` hook escapes it instead of emitting it verbatim, so a pasted `<script>` or an
//     `<img onerror=…>` in a job's or Bridget's markdown output lands in the inbox as inert
//     text, not a live tag.
//  2. Markdown's own `[text](url)` / `<url>` / `![alt](url)` syntax can still produce a live
//     `href`/`src` marked never treats as "raw HTML" (e.g. `[click](javascript:alert(1))`), so
//     the rendered body is also run through DOMPurify (fix round 1, task-5-review.md): links are
//     limited to http/https/mailto, image src to http/https, everything else is stripped. This
//     mirrors `shared/utils/sanitize-html.ts` / `app/components/clipboard/MessageText.vue`,
//     which use the same package for the same purpose on user-authored HTML.
import { Marked } from 'marked'
import DOMPurify from 'isomorphic-dompurify'

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ESCAPE[c]!)
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Both block-level raw HTML (`<script>…</script>` on its own line) and inline tags
    // (`<img onerror=…>` inline in text) route through here — escape rather than pass through.
    html({ text }) {
      return escapeHtml(text)
    }
  }
})

const CONTAINER_STYLE = [
  'max-width:640px', 'margin:0 auto', 'padding:24px',
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  'font-size:15px', 'line-height:1.5', 'color:#1a1a1a'
].join(';')

const ALLOWED_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const ALLOWED_IMAGE_SCHEMES = new Set(['http:', 'https:'])

/** The URI scheme of a (trimmed) attribute value, lower-cased with its trailing colon, or null
 *  for a schemeless (relative/fragment) value — which this policy also rejects: email HTML has
 *  no base URL to resolve a relative link/image against. */
function schemeOf(raw: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw.trim())
  return m ? `${m[1]!.toLowerCase()}:` : null
}

// DOMPurify hook, scoped to a single sanitize() call (added/removed around it — see `sanitize`
// below) rather than left registered globally, since `isomorphic-dompurify` is one process-wide
// singleton shared with `shared/utils/sanitize-html.ts`'s unrelated sanitize calls.
//
// This runs BEFORE DOMPurify's own URI check (dompurify's `_sanitizeAttributes`), so it fully
// overrides it — importantly, DOMPurify's *default* config allows `data:` src on <img> (its
// built-in DATA_URI_TAGS allow-list), which this policy deliberately does not.
//
// `node` is typed structurally (not the DOM lib's `Element`) — this file runs server-side,
// where the Nitro tsconfig has no `dom` lib; jsdom's Element (what dompurify actually passes
// here) satisfies this shape.
function restrictUrlSchemes(node: { tagName: string }, data: { attrName: string, attrValue: string, keepAttr: boolean }): void {
  if (data.attrName === 'href' && node.tagName === 'A') {
    const scheme = schemeOf(data.attrValue)
    if (!scheme || !ALLOWED_LINK_SCHEMES.has(scheme)) data.keepAttr = false
  }
  else if (data.attrName === 'src' && node.tagName === 'IMG') {
    const scheme = schemeOf(data.attrValue)
    if (!scheme || !ALLOWED_IMAGE_SCHEMES.has(scheme)) data.keepAttr = false
  }
}

function sanitize(html: string): string {
  DOMPurify.addHook('uponSanitizeAttribute', restrictUrlSchemes)
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick']
    })
  }
  finally {
    DOMPurify.removeHook('uponSanitizeAttribute', restrictUrlSchemes)
  }
}

/**
 * App-relative targets (`/api/images/<id>/raw`, `/tasks/…`) have no base URL in an inbox, so the
 * sanitizer would drop them (final review M4). With the app's `origin` they are made absolute, and
 * an app-relative IMAGE becomes a link to it (`[alt](origin/…)`, "image" when it has no alt): the
 * image route needs a session an email client doesn't have, so an inline <img> would be broken.
 * External (http/https) images are left inline. Without an origin nothing changes.
 */
export function absolutizeAppLinks(markdown: string, origin: string | undefined): string {
  if (!origin) return markdown
  const base = origin.replace(/\/+$/, '')
  return markdown.replace(/(!?)\[([^\]]*)\]\(\s*(\/(?!\/)[^)\s]*)\s*\)/g, (_m, bang: string, label: string, path: string) =>
    bang ? `[${label.trim() || 'image'}](${base}${path})` : `[${label}](${base}${path})`)
}

/** Renders a markdown message body for email. `text` is always the original markdown, unmodified.
 *  `origin` (the app's public origin) keeps app-relative links and images as working links (M4). */
export function renderEmail(markdown: string, opts: { origin?: string } = {}): { html: string, text: string } {
  const body = sanitize(marked.parse(absolutizeAppLinks(markdown, opts.origin), { async: false }))
  return { html: `<div style="${CONTAINER_STYLE}">${body}</div>`, text: markdown }
}

export function emailSubject(label: string): string {
  return `Bridget · ${label}`
}
