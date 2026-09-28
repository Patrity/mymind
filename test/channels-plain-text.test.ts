// Final review M7: iMessage text is converted from markdown to plain text.
import { describe, it, expect } from 'vitest'
import { markdownToPlainText as plain } from '../server/lib/channels/plain-text'

describe('markdownToPlainText', () => {
  it('strips heading markers', () => {
    expect(plain('# Today\n## Tasks ##\nstuff #1')).toBe('Today\nTasks\nstuff #1')
  })
  it('strips bold, italic and strikethrough markers', () => {
    expect(plain('**Bold** and __also__, *it* and _this_, ~~gone~~')).toBe('Bold and also, it and this, gone')
  })
  it('leaves snake_case, lone asterisks and maths alone', () => {
    expect(plain('call user_id_map and 2 * 3 * 4')).toBe('call user_id_map and 2 * 3 * 4')
  })
  it('links become "text (url)"; a bare-url link is just the url; autolinks lose their brackets', () => {
    expect(plain('See [the doc](https://x.test/d) or [https://x.test](https://x.test) or <https://y.test/a>'))
      .toBe('See the doc (https://x.test/d) or https://x.test or https://y.test/a')
  })
  it('an image embed becomes "alt (url)", or the url when it has no alt', () => {
    expect(plain('![chart](https://x.test/c.png) ![](https://x.test/d.png)')).toBe('chart (https://x.test/c.png) https://x.test/d.png')
  })
  it('inline code loses its backticks; a fenced block keeps its lines without the fences', () => {
    expect(plain('Run `ls -la`:\n```sh\nls -la\n**not bold**\n```\ndone')).toBe('Run ls -la:\nls -la\n**not bold**\ndone')
  })
  it('drops blockquote markers and horizontal rules; list markers stay', () => {
    expect(plain('> quoted\n\n---\n\n- one\n- **two**\n1. three')).toBe('quoted\n\n- one\n- two\n1. three')
  })
  it('plain text is unchanged', () => {
    expect(plain("Sorry — something went wrong answering that.")).toBe("Sorry — something went wrong answering that.")
  })
})
