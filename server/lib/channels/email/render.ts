// server/lib/channels/email/render.ts
// Markdown -> HTML for the email channel body. `renderEmail` never passes raw HTML from the
// source through: the renderer's `html()` hook escapes it instead of emitting it verbatim, so a
// pasted `<script>` or an `<img onerror=…>` in a job's or Bridget's markdown output lands in the
// inbox as inert text, not a live tag.
import { Marked } from 'marked'

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

/** Renders a markdown message body for email. `text` is always the original markdown, unmodified. */
export function renderEmail(markdown: string): { html: string, text: string } {
  const body = marked.parse(markdown, { async: false })
  return { html: `<div style="${CONTAINER_STYLE}">${body}</div>`, text: markdown }
}

export function emailSubject(label: string): string {
  return `Bridget · ${label}`
}
