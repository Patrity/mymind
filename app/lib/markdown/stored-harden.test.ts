// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"disableJavaScriptFileLoading":true,"disableJavaScriptEvaluation":true}}
//
// Cycle 88: stored content (documents, triage, shared docs, config previews, clipboard) renders
// through the REAL MdView → @nuxtjs/mdc <MDC> (real parseMarkdown) → <MDCRenderer> chain, and
// clipboard rich HTML through hardenStoredHtml → the browser's own HTML parser (v-html). For every
// exfil vector, no element or attribute that loads from the network may survive.
// (Not covered here: the app's shiki highlighter and Nuxt UI prose components are Nuxt-registered
// and absent under vitest — the browser pass in the cycle-88 handover covers those.)
import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, Suspense } from 'vue'
import MDC from '@nuxtjs/mdc/runtime/components/MDC.vue'
import MDCRenderer from '@nuxtjs/mdc/runtime/components/MDCRenderer.vue'
import MdView from '~/components/MdView.vue'
import { EVIL, STORED_VECTORS } from './exfil-vectors.fixture'
import { hardenMdcBody, hardenStoredHtml, isAllowedStoredImage, isLocalIcon, isSafeHref } from './stored-harden'

vi.mock('nuxt/app', () => ({
  // MDC.vue's only Nuxt dependency: run the parse once and hand back refs, as Nuxt would.
  useAsyncData: async (_key: string, fn: () => Promise<unknown>) => {
    const data = ref(await fn())
    return { data, error: ref(null), refresh: async () => { data.value = await fn() } }
  }
}))
vi.stubGlobal('useRequestURL', () => new URL('https://mymind.test/documents'))
vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'log').mockImplementation(() => {})

const ORIGIN = 'https://mymind.test'

async function flush() {
  for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() }
}

/** Mount the real MdView (optionally with the hardening swapped out, for the not-vacuous check). */
async function renderMd(source: string, rendererOverride?: object): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({ render: () => h(Suspense, null, { default: () => h(MdView, { source }) }) })
  app.component('MDC', MDC)
  app.component('MDCRenderer', rendererOverride ?? MDCRenderer)
  app.mount(el)
  await flush()
  return el
}

function renderHtml(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = hardenStoredHtml(html, { origin: ORIGIN })
  return el
}

// The oracle is independent of the code under test (a mutated isLocalIcon / isAllowedStoredImage
// must not also loosen the assertion).
const ORACLE_LOCAL_ICON = /^(?:i-(?:lucide|simple-icons)-|(?:lucide|simple-icons):)[a-z0-9]+(?:-[a-z0-9]+)*$/
const ORACLE_SAFE_IMG = /^(?:\/api\/(?:images|i)\/[\w-]+(?:\/raw)?|https:\/\/mymind\.test\/api\/i\/[\w-]+|data:image\/png;base64,[\w+/=]+)$/
const FETCHING_TAGS = /^(style|link|video|audio|source|picture|iframe|frame|object|embed|script|image|svg|meta|base|portal|track|input)$/i
const URL_ATTRS = new Set(['src', 'srcset', 'poster', 'background', 'ping', 'data', 'style', 'xlink:href', 'action', 'formaction', 'lowsrc', 'dynsrc', 'srcdoc', 'imagesrcset'])

/** Every element/attribute that could make the browser fetch on render. Links (`a[href]`) are
 *  allowed — a click is the user's choice — but must carry rel="noopener noreferrer". */
function leaks(el: HTMLElement): string[] {
  const out: string[] = []
  for (const n of el.querySelectorAll('*')) {
    const tag = n.tagName.toLowerCase()
    if (FETCHING_TAGS.test(tag) && !(tag === 'input' && n.getAttribute('type') === 'checkbox')) out.push(`<${tag}>`)
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase()
      if (name.startsWith('on')) out.push(`${tag}[${name}]`)
      else if (URL_ATTRS.has(name) && !(tag === 'img' && name === 'src') && /evil|url\(|\/\//i.test(a.value)) out.push(`${tag}[${name}]=${a.value}`)
      else if (name === 'href' && tag !== 'a') out.push(`${tag}[href]=${a.value}`)
      else if (name === 'href' && /^\s*javascript:/i.test(a.value)) out.push(`a[href]=${a.value}`)
      else if (name === 'to' && (/^\s*javascript:/i.test(a.value) || !/^(https?:|\/|#)/.test(a.value))) out.push(`${tag}[to]=${a.value}`)
      else if ((name === 'icon' || (tag === 'icon' && name === 'name')) && !ORACLE_LOCAL_ICON.test(a.value)) out.push(`${tag}[${name}]=${a.value} (Iconify API fetch)`)
      else if (name === 'as') out.push(`${tag}[as]=${a.value}`)
    }
    if (tag === 'icon' && !ORACLE_LOCAL_ICON.test(n.getAttribute('name') ?? '')) out.push(`<icon> without a local name`)
    if (/^(?:u-?button|u-?link|nuxt-?link|u-?modal|client-?only)$/.test(tag)) out.push(`<${tag}> (unvetted registered component)`)
    if (tag === 'img' && !ORACLE_SAFE_IMG.test(n.getAttribute('src') ?? '')) out.push(`img[src]=${n.getAttribute('src')}`)
    if (tag === 'a' && n.hasAttribute('href') && !/\bnoopener\b/.test(n.getAttribute('rel') ?? '')) out.push(`a without rel=noopener: ${n.getAttribute('href')}`)
    if (tag === 'a' && n.hasAttribute('href') && !/\bnoreferrer\b/.test(n.getAttribute('rel') ?? '')) out.push(`a without rel=noreferrer: ${n.getAttribute('href')}`)
  }
  return out
}

describe('MdView (stored markdown) — real MDC renderer', () => {
  it.each(Object.entries(STORED_VECTORS))('%s: nothing in the DOM loads from the network', async (_name, md) => {
    expect(leaks(await renderMd(md))).toEqual([])
  })

  it('NOT vacuous: the unhardened MDC chain (what MdView did before cycle 88) leaks most vectors', async () => {
    // Same MDC parse, but MDCRenderer gets the raw body and the frontmatter data — the pre-88 path.
    const leaked: string[] = []
    for (const [name, md] of Object.entries(STORED_VECTORS)) {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const app = createApp({ render: () => h(Suspense, null, { default: () => h(MDC, { value: md }) }) })
      app.component('MDCRenderer', MDCRenderer)
      app.mount(el)
      await flush()
      if (leaks(el).length) leaked.push(name)
    }
    expect(leaked).toEqual(expect.arrayContaining(['markdown image', 'raw <img>', 'inline style=url()', '<iframe>', '<video poster>', 'MDC inline img component']))
  })

  it('vetted MDC components survive with their safe props (card, tabs, icon, callout, slots)', async () => {
    const el = await renderMd([
      '::card{title="Card title" icon="i-lucide-star" to="https://docs.example" color="primary"}',
      '#description', 'Slot text', '#default', 'Card body', '::', '',
      '::tabs{default-value="0"}', ':::tabs-item{label="First" icon="i-lucide-house"}', 'tab one', ':::',
      ':::tabs-item{label="Second"}', 'tab two', ':::', '::', '',
      'An icon :icon{name="i-lucide-house"} and a brand :icon{name="i-simple-icons-github"}', '',
      '::note', 'A note', '::', '',
      '::mc-callout{type="warning"}', 'Careful', '::', '',
      '::collapsible{title="More"}', 'Hidden', '::'
    ].join('\n'))
    const card = el.querySelector('card')
    expect(card?.getAttribute('title')).toBe('Card title')
    expect(card?.getAttribute('icon')).toBe('i-lucide-star')
    expect(card?.getAttribute('to')).toBe('https://docs.example')
    expect(card?.getAttribute('color')).toBe('primary')
    expect(card?.textContent).toContain('Card body')
    expect(el.querySelector('tabs')?.getAttribute('default-value')).toBe('0')
    // MDCRenderer resolves tags by PascalCase name; unregistered under vitest, tabs-item renders as <tabsitem>.
    expect([...el.querySelectorAll('tabsitem')].map(t => t.getAttribute('label'))).toEqual(['First', 'Second'])
    expect(el.querySelector('tabsitem')?.getAttribute('icon')).toBe('i-lucide-house')
    expect([...el.querySelectorAll('icon')].map(i => i.getAttribute('name'))).toEqual(['i-lucide-house', 'i-simple-icons-github'])
    expect(el.querySelector('note')?.textContent).toContain('A note')
    expect(el.querySelector('mccallout')?.getAttribute('type')).toBe('warning')
    expect(el.querySelector('collapsible')?.getAttribute('title')).toBe('More')
    expect(leaks(el)).toEqual([])
  })

  it('unvetted components are inert: remote icons / unknown components / bad props removed, text kept', async () => {
    const el = await renderMd([
      '::card{title="T" icon="i-mdi-secret" to="javascript:alert(1)" style="background:red" :color="x"}', 'body', '::', '',
      ':icon{name="i-mdi-secret"} :icon{name="mdi:secret"}', '',
      '::u-button{to="https://evil.example"}', 'button text', '::'
    ].join('\n'))
    const card = el.querySelector('card')!
    expect([...card.attributes].map(a => a.name)).toEqual(['title'])
    expect(el.querySelectorAll('icon').length).toBe(0)
    expect(el.querySelector('ubutton, u-button')).toBeNull()
    expect(el.textContent).toContain('button text')
  })

  it('a blocked image becomes a clickable link, not an <img>', async () => {
    const el = await renderMd(`![invoice totals](${EVIL}/p.png?d=1)`)
    expect(el.querySelector('img')).toBeNull()
    const a = el.querySelector('a.mm-md-blocked-img')
    expect(a?.getAttribute('href')).toBe(`${EVIL}/p.png?d=1`)
    expect(a?.textContent).toContain('invoice totals')
    expect(a?.getAttribute('rel')).toEqual(expect.stringMatching(/noopener noreferrer/))
  })

  it('normal documents still render: headings, lists, code, tables, links, task list, same-origin images', async () => {
    const el = await renderMd([
      '# Title', '## Sub', '**bold** and `code`', '', '- one', '- [x] done', '',
      '```ts', 'const x = 1', '```', '',
      '| a | b |', '|:-|-:|', '| 1 | 2 |', '',
      '[docs](https://docs.example) and [home](/documents)', '',
      '![cat](/api/images/img1/raw) ![pub](/api/i/abc123) ![abs](https://mymind.test/api/i/xyz) ![dot](data:image/png;base64,iVBORw0KGgo=)'
    ].join('\n'))
    expect(el.querySelector('h1')?.textContent).toBe('Title')
    expect(el.querySelector('h2')?.textContent).toBe('Sub')
    expect(el.querySelector('strong')?.textContent).toBe('bold')
    expect(el.querySelectorAll('li').length).toBeGreaterThanOrEqual(2)
    expect(el.querySelector('input[type="checkbox"]')).not.toBeNull()
    expect(el.querySelector('pre')?.textContent).toContain('const x = 1')
    expect(el.querySelectorAll('td').length).toBe(2)
    expect(el.querySelector('a[href="https://docs.example"]')?.getAttribute('target')).toBe('_blank')
    expect(el.querySelector('a[href="/documents"]')).not.toBeNull()
    expect([...el.querySelectorAll('img')].map(i => i.getAttribute('src'))).toEqual([
      '/api/images/img1/raw', '/api/i/abc123', 'https://mymind.test/api/i/xyz', 'data:image/png;base64,iVBORw0KGgo='
    ])
    expect(leaks(el)).toEqual([])
  })
})

describe('hardenStoredHtml (clipboard rich HTML) — real DOMPurify + HTML parser', () => {
  it.each(Object.entries(STORED_VECTORS))('%s: nothing in the DOM loads from the network', (_name, html) => {
    expect(leaks(renderHtml(html))).toEqual([])
  })

  it('NOT vacuous: the pre-88 DOMPurify config leaks remote images and style url()', async () => {
    const DOMPurify = (await import('isomorphic-dompurify')).default
    const old = (html: string) => {
      const el = document.createElement('div')
      el.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'], FORBID_ATTR: ['onerror', 'onload', 'onclick'] }) as string
      return el
    }
    expect(leaks(old(STORED_VECTORS['raw <img>']!))).not.toEqual([])
    expect(leaks(old(STORED_VECTORS['inline style=url()']!))).not.toEqual([])
  })

  it('keeps ordinary rich paste formatting', () => {
    const el = renderHtml('<p><b>bold</b> <a href="https://x.example">x</a></p><ul><li>a</li></ul><table><tr><td>1</td></tr></table><img src="/api/images/a/raw" alt="ok">')
    expect(el.querySelector('b')?.textContent).toBe('bold')
    expect(el.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(el.querySelector('li')?.textContent).toBe('a')
    expect(el.querySelector('td')?.textContent).toBe('1')
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/images/a/raw')
  })
})

describe('isAllowedStoredImage / isSafeHref / hardenMdcBody', () => {
  const o = { origin: ORIGIN }
  it.each(['/api/images/x/raw', '/api/i/slug', `${ORIGIN}/api/i/slug`, 'data:image/png;base64,AAAA', `blob:${ORIGIN}/uuid`])('allows image %s', s => expect(isAllowedStoredImage(s, o)).toBe(true))
  it.each([`${EVIL}/x.png`, '//evil.example/x', '/api/images/../../x', '/api/images//evil.example', '/x.png', 'data:image/svg+xml,<svg/>', 'data:text/html,x', `${EVIL}/api/i/x`, 'blob:https://evil.example/u', undefined])('refuses image %s', s => expect(isAllowedStoredImage(s, o)).toBe(false))
  it.each(['https://x', 'http://x', 'mailto:a@b', '#frag', '/documents', './a', 'page'])('allows href %s', h2 => expect(isSafeHref(h2)).toBe(true))
  it.each(['javascript:alert(1)', ' JavaScript:x', 'data:text/html,x', 'vbscript:x', 'java\tscript:x'])('refuses href %s', h2 => expect(isSafeHref(h2)).toBe(false))
  it.each(['i-lucide-house', 'i-simple-icons-github', 'lucide:star'])('local icon %s', n => expect(isLocalIcon(n)).toBe(true))
  it.each(['i-mdi-home', 'mdi:home', 'i-lucide-', 'i-lucide-../x', 'https://evil.example/x.svg', 'i-lucide-a b', undefined])('remote/invalid icon %s', n => expect(isLocalIcon(n)).toBe(false))
  it('prototype keys are not allowlisted (tag "constructor", prop "toString")', () => {
    const out = hardenMdcBody({ type: 'root', children: [
      { type: 'element', tag: 'constructor', props: {}, children: [{ type: 'text', value: 't' }] },
      { type: 'element', tag: 'p', props: { toString: 'x', constructor: 'y' }, children: [] }
    ] })
    expect(out.children).toEqual([{ type: 'text', value: 't' }, { type: 'element', tag: 'p', props: {}, children: [] }])
  })
  it('keeps shiki colour variables, drops any other style', () => {
    const out = hardenMdcBody({ type: 'root', children: [
      { type: 'element', tag: 'span', props: { style: '--shiki-default:#82AAFF;--shiki-dark:#82AAFF' }, children: [] },
      { type: 'element', tag: 'span', props: { style: `--shiki-default:url(${EVIL}/x)` }, children: [] },
      { type: 'element', tag: 'span', props: { style: 'color:red;background:url(x)' }, children: [] }
    ] })
    expect(out.children!.map(c => c.props?.style)).toEqual(['--shiki-default:#82AAFF;--shiki-dark:#82AAFF', undefined, undefined])
  })
  it('does not mutate the cached input tree', () => {
    const input = { type: 'root', children: [{ type: 'element', tag: 'img', props: { src: `${EVIL}/x` }, children: [] }] }
    const copy = JSON.parse(JSON.stringify(input))
    hardenMdcBody(input)
    expect(input).toEqual(copy)
  })
})
