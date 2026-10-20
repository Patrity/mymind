// app/lib/markdown/stored-harden.ts
//
// Zero-click exfil hardening for markdown/HTML from data at rest (cycle 88). The agent-chat
// renderer has had this since 79b (app/lib/agent/markdown-harden.ts); stored content is just as
// attacker-influenced — documents ingested from mail / web / captures, triage cards built from
// inbound email, agent-editable config previewed in MarkdownConfigEditor, clipboard rich pastes.
// One policy for ALL stored content (provenance is not tracked reliably, so self-written
// documents are not exempt):
//   - an image loads only from same-origin `/api/images/…` / `/api/i/…` (relative, or absolute on
//     the app's own origin), `data:image/…` or `blob:`. Any other image becomes a plain link
//     ("Remote image: <alt>") — a click is Tony's choice, a render is not;
//   - only plain-markdown tags survive. Raw-HTML / MDC-component tags are dropped with their
//     content (style, link, iframe, object, embed, svg, video, …) or unwrapped to their text
//     (div, span-less components, `::card`, `:icon`, …) — Nuxt UI prose components such as
//     ProseIcon/ProseCard take props that fetch;
//   - each surviving tag keeps only attributes plain markdown produces: no on*, no style (except
//     table text-align and shiki's colour variables), no ping/poster/srcset, no `:bound` props;
//   - links stay clickable, get rel="noopener noreferrer", and only http(s)/mailto/tel/relative/
//     fragment hrefs survive.
//
// Two entry points: `hardenMdcBody` for the @nuxtjs/mdc AST (MdView), and `hardenStoredHtml`
// for raw HTML going through DOMPurify (clipboard rich pastes).

import DOMPurify from 'isomorphic-dompurify'

export interface MdcNode {
  type: string
  tag?: string
  props?: Record<string, unknown>
  children?: MdcNode[]
  value?: string
}

export interface HardenOptions {
  /** The app's own origin (`useRequestURL().origin`), so absolute `${origin}/api/i/…` links
   *  copied from the gallery still render. Omit to allow only relative same-origin images. */
  origin?: string
}

const IMAGE_PREFIXES = ['/api/images/', '/api/i/']
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i

/** Whether an <img src> may load: same-origin image routes, data: rasters, blob:. */
export function isAllowedStoredImage(src: unknown, opts: HardenOptions = {}): boolean {
  if (typeof src !== 'string') return false
  const s = src.trim()
  if (DATA_IMAGE.test(s)) return true
  if (/^blob:/i.test(s)) return opts.origin ? s.slice(5).startsWith(`${opts.origin}/`) : true
  let path = s
  if (opts.origin && s.startsWith(`${opts.origin}/`)) path = s.slice(opts.origin.length)
  return IMAGE_PREFIXES.some(p => path.startsWith(p))
    && !path.includes('..')
    && !path.includes('\\')
    && !path.slice(1).includes('//')
    && !/[\s"'<>]/.test(path)
}

const SAFE_HREF = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|[^:/?#]*(?:[/?#]|$))/i

/** Whether a link href is navigable (no javascript:/data:/vbscript: or other schemes). */
export function isSafeHref(href: unknown): href is string {
  return typeof href === 'string' && !/[\u0000-\u001F]/.test(href) && SAFE_HREF.test(href.trim())
}

const TEXT_ALIGN = /^text-align:\s*(?:left|right|center);?$/
// Shiki (the MDC highlighter) colours tokens with inline CSS variables; nothing else may carry style.
const SHIKI_DECL = /^\s*--shiki-[\w-]+\s*:\s*(?:#[0-9a-f]{3,8}|[a-z-]+)\s*$/i
function isShikiStyle(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const decls = v.split(';').filter(d => d.trim())
  return decls.length > 0 && decls.every(d => SHIKI_DECL.test(d))
}

type Rule = (v: unknown) => boolean
const str: Rule = v => typeof v === 'string'
const cls: Rule = v => (typeof v === 'string' && /^[\w -]*$/.test(v))
  || (Array.isArray(v) && v.every(c => typeof c === 'string' && /^[\w-]+$/.test(c)))
const ident: Rule = v => typeof v === 'string' && /^[\w-]*$/.test(v)
const bool: Rule = v => typeof v === 'boolean' || v === '' || v === 'true' || v === 'false'
/** data-* / aria-* (camelCased by hast) never fetch; keep them for footnotes / a11y. */
const isDataOrAria = (k: string) => /^(?:data|aria)[A-Z][\w]*$/.test(k) || /^(?:data|aria)-[\w-]+$/.test(k)

/** tag → prop → validator. Tags not listed are unwrapped (or dropped, see DROP). */
const ALLOWED: Record<string, Record<string, Rule>> = (() => {
  const base = { className: cls, class: cls, id: ident }
  const t: Record<string, Record<string, Rule>> = {}
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'del', 's', 'b', 'i', 'u', 'mark',
    'code', 'ul', 'li', 'thead', 'tbody', 'tfoot', 'tr', 'table', 'caption', 'hr', 'br', 'sup', 'sub', 'section',
    'kbd', 'details', 'summary', 'dl', 'dt', 'dd', 'blockquote', 'abbr',
    // Nuxt UI alert-style prose components: rendered with fixed local icons, no props kept.
    'note', 'tip', 'warning', 'caution', 'callout']) t[tag] = { ...base }
  t.ol = { ...base, start: v => /^\d+$/.test(String(v)) }
  t.a = { ...base, href: isSafeHref, title: str }
  t.img = { alt: str, title: str, width: v => /^\d+$/.test(String(v)), height: v => /^\d+$/.test(String(v)) } // src handled below
  t.input = { ...base, type: v => v === 'checkbox', checked: bool, disabled: bool }
  t.th = { ...base, align: v => v === 'left' || v === 'right' || v === 'center', style: v => typeof v === 'string' && TEXT_ALIGN.test(v) }
  t.td = { ...t.th }
  t.pre = { ...base, language: v => typeof v === 'string' && /^[\w+#.-]*$/.test(v), filename: str, code: str, meta: str,
    highlights: v => Array.isArray(v) && v.every(n => typeof n === 'number'), style: isShikiStyle }
  t.span = { ...base, style: isShikiStyle }
  t.code = { ...base, __ignoreMap: () => true, style: isShikiStyle }
  return t
})()

/** Dropped WITH their content: they render nothing useful as text and can all fetch or run.
 *  (`template` is NOT here: MDC compiles component slots `#name` to <template>, unwrapped.) */
const DROP = new Set(['style', 'script', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'svg', 'math', 'video', 'audio', 'source', 'track', 'picture', 'image', 'noscript', 'form',
  'textarea', 'select', 'button', 'canvas', 'portal', 'fencedframe', 'head', 'title', 'param'])

function text(value: string): MdcNode { return { type: 'text', value } }

/** The link a blocked remote image turns into. Kept clickable (http/https only), never loaded. */
function blockedImageNode(src: unknown, alt: unknown): MdcNode {
  const label = `Remote image${typeof alt === 'string' && alt.trim() ? `: ${alt.trim()}` : ''}`
  const href = typeof src === 'string' && /^(?:https?:)?\/\//i.test(src.trim()) ? src.trim() : undefined
  if (!href) return { type: 'element', tag: 'span', props: { className: ['mm-md-blocked-img'] }, children: [text(`[${label}]`)] }
  return {
    type: 'element', tag: 'a',
    props: { href, rel: 'noopener noreferrer nofollow', target: '_blank', className: ['mm-md-blocked-img'], title: 'Not loaded automatically — click to open' },
    children: [text(`[${label}]`)]
  }
}

function hardenNodes(nodes: MdcNode[] | undefined, opts: HardenOptions): MdcNode[] {
  const out: MdcNode[] = []
  for (const n of nodes ?? []) {
    if (!n || typeof n !== 'object') continue
    if (n.type === 'text') { out.push(text(String(n.value ?? ''))); continue }
    if (n.type !== 'element' || typeof n.tag !== 'string') continue // comments, raw, bindings
    const name = n.tag.toLowerCase()
    if (DROP.has(name)) continue
    const rules = ALLOWED[name]
    if (!rules) { out.push(...hardenNodes(n.children, opts)); continue } // div / MDC component → its content
    const props = n.props ?? {}
    if (name === 'img' && !isAllowedStoredImage(props.src, opts)) { out.push(blockedImageNode(props.src, props.alt)); continue }
    if (name === 'input' && props.type !== 'checkbox') continue
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (rules[k]?.(v)) clean[k] = v
      else if (isDataOrAria(k) && (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) clean[k] = v
    }
    if (name === 'img') clean.src = String(props.src).trim()
    if (name === 'a') {
      if (!('href' in clean)) { out.push(...hardenNodes(n.children, opts)); continue }
      clean.rel = 'noopener noreferrer'
      if (/^(?:https?:)?\/\//i.test(String(clean.href))) clean.target = '_blank'
    }
    out.push({ type: 'element', tag: name, props: clean, children: hardenNodes(n.children, opts) })
  }
  return out
}

/** Return a hardened COPY of a parsed MDC body (root). Never mutates the input (it is the
 *  useAsyncData cache). */
export function hardenMdcBody<T extends MdcNode | null | undefined>(body: T, opts: HardenOptions = {}): T {
  if (!body) return body
  return { ...body, children: hardenNodes(body.children, opts) } as T
}

const PURIFY_FORBID_TAGS = [...DROP, 'template']
const PURIFY_FORBID_ATTR = ['style', 'srcset', 'ping', 'poster', 'background', 'action', 'formaction', 'xlink:href',
  'lowsrc', 'dynsrc', 'longdesc', 'usemap', 'manifest', 'codebase', 'data', 'srcdoc', 'imagesrcset', 'href:image', 'cite']

/** Sanitize stored rich HTML (clipboard bodyHtml) under the same policy as hardenMdcBody. */
export function hardenStoredHtml(html: string, opts: HardenOptions = {}): string {
  const hook = (node: Element) => {
    const tag = node.nodeName.toLowerCase()
    if (tag === 'img') {
      const src = node.getAttribute('src')
      if (!isAllowedStoredImage(src, opts)) {
        const doc = node.ownerDocument
        const alt = node.getAttribute('alt')
        const label = `[Remote image${alt && alt.trim() ? `: ${alt.trim()}` : ''}]`
        const href = src && /^(?:https?:)?\/\//i.test(src.trim()) ? src.trim() : null
        const repl = doc.createElement(href ? 'a' : 'span')
        repl.textContent = label
        repl.setAttribute('class', 'mm-md-blocked-img')
        if (href) { repl.setAttribute('href', href); repl.setAttribute('rel', 'noopener noreferrer nofollow'); repl.setAttribute('target', '_blank') }
        node.replaceWith(repl)
      }
      return
    }
    if (tag === 'a') {
      const href = node.getAttribute('href')
      if (href !== null && !isSafeHref(href)) node.removeAttribute('href')
      node.setAttribute('rel', 'noopener noreferrer')
      if (href && /^(?:https?:)?\/\//i.test(href.trim())) node.setAttribute('target', '_blank')
      return
    }
    if (tag === 'input' && node.getAttribute('type') !== 'checkbox') { node.remove(); return }
    // Any other element: drop attributes that can name a URL to fetch.
    for (const a of ['src', 'href']) if (node.hasAttribute(a)) node.removeAttribute(a)
  }
  DOMPurify.addHook('afterSanitizeAttributes', hook)
  try {
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: PURIFY_FORBID_TAGS,
      FORBID_ATTR: PURIFY_FORBID_ATTR,
      ADD_ATTR: ['target'],
      USE_PROFILES: { html: true }
    }) as string
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}
