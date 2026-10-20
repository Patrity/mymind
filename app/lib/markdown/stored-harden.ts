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
//   - only plain-markdown tags and an explicit allowlist of the app's own MDC components survive
//     (Nuxt UI prose: callout/note/tip/warning/caution, card, card-group, tabs, tabs-item, steps,
//     accordion, accordion-item, badge, kbd, icon, collapsible, code-group, code-collapse,
//     code-preview, field, field-group; the app's own app/components/content: Note, Collapsible,
//     McCallout — each with a vetted prop list). Other raw-HTML / MDC tags
//     are dropped with their content (style, link, iframe, object, embed, svg, video, …) or
//     unwrapped to their text (div, `::u-button`, any other registered component — MDC resolves
//     ANY global component by tag name);
//   - icons (`icon`/`name` props) must name the locally bundled collections (lucide, simple-icons):
//     @nuxt/icon falls back to api.iconify.design for any other collection (fallbackToApi), which
//     would put an attacker-chosen icon name on the wire at render time;
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
const plain: Rule = v => typeof v === 'string' && v.length <= 200
const safeTo: Rule = v => isSafeHref(v)
const blankTarget: Rule = v => v === '_blank' || v === '_self'
const uiColor: Rule = v => typeof v === 'string' && /^(?:primary|secondary|success|info|warning|error|neutral)$/.test(v)

/** Icon collections installed locally (`@iconify-json/*` in package.json) — served by the app's
 *  own /api/_nuxt_icon endpoint. Any other collection makes @nuxt/icon fetch api.iconify.design. */
export const LOCAL_ICON_COLLECTIONS = ['lucide', 'simple-icons']
const ICON_RE = new RegExp(`^(?:i-(?:${LOCAL_ICON_COLLECTIONS.join('|')})-|(?:${LOCAL_ICON_COLLECTIONS.join('|')}):)[a-z0-9]+(?:-[a-z0-9]+)*$`)
/** Whether an icon name resolves from a locally bundled collection (never the Iconify API). */
export const isLocalIcon: Rule = v => typeof v === 'string' && ICON_RE.test(v)

/** MDC components the app registers (Nuxt UI prose) that load nothing remote, with their
 *  vetted props (camelCase; kebab-case attributes are matched too). `to` is a click-only link. */
const COMPONENTS: Record<string, Record<string, Rule>> = {
  'callout': { to: safeTo, target: blankTarget, icon: isLocalIcon, color: uiColor },
  'note': { to: safeTo, target: blankTarget },
  'tip': { to: safeTo, target: blankTarget },
  'warning': { to: safeTo, target: blankTarget },
  'caution': { to: safeTo, target: blankTarget },
  'card': { to: safeTo, target: blankTarget, icon: isLocalIcon, title: plain, description: plain, color: uiColor },
  'card-group': {},
  'tabs': { defaultValue: ident },
  'tabs-item': { label: plain, description: plain, icon: isLocalIcon },
  'steps': { level: v => /^[1-6]$/.test(String(v)) },
  'accordion': { type: v => v === 'single' || v === 'multiple' },
  'accordion-item': { label: plain, description: plain, icon: isLocalIcon },
  'badge': {},
  'icon': { name: isLocalIcon },
  // `collapsible` is ambiguous on purpose: app/components/content/Collapsible.vue (title) and Nuxt
  // UI ProseCollapsible (icon/name/openText/closeText) — the union is all plain text / local icon.
  'collapsible': { title: plain, icon: isLocalIcon, name: plain, openText: plain, closeText: plain },
  // app/components/content/McCallout.vue — fixed local icons per type.
  'mc-callout': { type: v => v === 'info' || v === 'warning' || v === 'success' || v === 'error' },
  'code-collapse': { icon: isLocalIcon, name: plain, openText: plain, closeText: plain },
  'code-group': { defaultValue: ident },
  'code-preview': {},
  'field': { name: plain, type: plain, description: plain, required: bool },
  'field-group': {}
}
const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
/** A component slot: `#name` compiles to <template v-slot:name>. */
const isSlotProp = (k: string, v: unknown) => /^(?:v-slot:|#)[\w-]+$/.test(k) && (v === '' || v === true)
/** data-* / aria-* (camelCased by hast) never fetch; keep them for footnotes / a11y. */
const isDataOrAria = (k: string) => /^(?:data|aria)[A-Z][\w]*$/.test(k) || /^(?:data|aria)-[\w-]+$/.test(k)

/** tag → prop → validator. Tags not listed are unwrapped (or dropped, see DROP). */
const ALLOWED: Record<string, Record<string, Rule>> = (() => {
  const base = { className: cls, class: cls, id: ident }
  const t: Record<string, Record<string, Rule>> = {}
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'del', 's', 'b', 'i', 'u', 'mark',
    'code', 'ul', 'li', 'thead', 'tbody', 'tfoot', 'tr', 'table', 'caption', 'hr', 'br', 'sup', 'sub', 'section',
    'details', 'summary', 'dl', 'dt', 'dd', 'blockquote', 'abbr']) t[tag] = { ...base }
  for (const [tag, rules] of Object.entries(COMPONENTS)) t[tag] = { ...base, ...rules }
  t.kbd = { ...base, value: plain }
  t.template = {} // slot props only (isSlotProp)
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
 *  (`template` is NOT here: MDC compiles component slots `#name` to <template v-slot:name>.) */
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
    const rules = Object.hasOwn(ALLOWED, name) ? ALLOWED[name] : undefined // not ALLOWED['constructor']
    if (!rules) { out.push(...hardenNodes(n.children, opts)); continue } // div / MDC component → its content
    const props = n.props ?? {}
    if (name === 'img' && !isAllowedStoredImage(props.src, opts)) { out.push(blockedImageNode(props.src, props.alt)); continue }
    if (name === 'input' && props.type !== 'checkbox') continue
    if (name === 'icon' && !isLocalIcon(props.name)) continue // ProseIcon needs a name; a remote one is a fetch
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      const rule = Object.hasOwn(rules, k) ? rules[k] : Object.hasOwn(rules, camel(k)) ? rules[camel(k)] : undefined
      if (rule?.(v)) clean[k] = v
      else if (name === 'template' && isSlotProp(k, v)) clean[k] = v
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
