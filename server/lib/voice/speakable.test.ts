import { describe, it, expect } from 'vitest'
import { toSpeakable } from './speakable'

describe('toSpeakable', () => {
  it('strips emphasis markers but keeps the words', () => {
    expect(toSpeakable('Here are your **6 active projects**:')).toBe('Here are your 6 active projects:')
    expect(toSpeakable('that is _really_ important')).toBe('that is really important')
    expect(toSpeakable('a __bold__ and *italic* mix')).toBe('a bold and italic mix')
  })

  it('strips heading markers', () => {
    expect(toSpeakable('# Deploying a Nuxt App')).toBe('Deploying a Nuxt App')
    expect(toSpeakable('## 1. Provision the LXC')).toBe('1. Provision the LXC')
  })

  it('strips list bullets but keeps ordered numbering', () => {
    expect(toSpeakable('- mymind is the app')).toBe('mymind is the app')
    expect(toSpeakable('* another item')).toBe('another item')
    expect(toSpeakable('2. second step')).toBe('2. second step')
  })

  it('keeps link labels and drops the URL', () => {
    expect(toSpeakable('see [the roadmap](https://example.com/x)')).toBe('see the roadmap')
  })

  it('drops fenced code blocks entirely', () => {
    expect(toSpeakable('Run this:\n```bash\npnpm dev --port 3000\n```\nthen open it'))
      .toBe('Run this: then open it')
  })

  it('reads inline code as its content without backticks', () => {
    expect(toSpeakable('set `playbackRate` to one')).toBe('set playbackRate to one')
  })

  it('drops tables', () => {
    expect(toSpeakable('Results:\n| a | b |\n|---|---|\n| 1 | 2 |\ndone')).toBe('Results: done')
  })

  it('drops blockquote markers and horizontal rules', () => {
    expect(toSpeakable('> quoted thing')).toBe('quoted thing')
    expect(toSpeakable('before\n---\nafter')).toBe('before after')
  })

  it('expands an IPv4 address digit-group by digit-group', () => {
    expect(toSpeakable('the rig is at 192.168.2.25'))
      .toBe('the rig is at one ninety two dot one sixty eight dot two dot twenty five')
  })

  it('expands a version number', () => {
    expect(toSpeakable('running v1.2 now')).toBe('running version one point two now')
    expect(toSpeakable('Qwen 3.6 is the model')).toBe('Qwen three point six is the model')
  })

  it('speaks a leading-slash path as a page name', () => {
    expect(toSpeakable('open /agent to see it')).toBe('open the agent page to see it')
  })

  it('collapses the whitespace it creates', () => {
    expect(toSpeakable('**a**\n\n\n**b**')).toBe('a b')
  })

  it('returns plain prose untouched', () => {
    const s = 'Your six active projects are mymind and bridget-services.'
    expect(toSpeakable(s)).toBe(s)
  })

  it('never throws on malformed markdown', () => {
    expect(() => toSpeakable('**unclosed and ```also unclosed')).not.toThrow()
  })
})
