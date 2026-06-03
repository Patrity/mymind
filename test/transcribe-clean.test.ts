import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the chat module before importing transcribe
vi.mock('../server/lib/ai/chat', () => ({
  chat: vi.fn()
}))

// Also stub useRuntimeConfig so provider.ts doesn't throw in the module graph
vi.stubGlobal('useRuntimeConfig', () => ({
  ai: {
    reasoning: { baseURL: 'http://x/v1', apiKey: 'k', model: 'm' },
    vision: { baseURL: '', apiKey: '', model: '' },
    embeddings: { baseURL: '', apiKey: '', model: '' }
  }
}))

import { chat } from '../server/lib/ai/chat'
import { cleanToMarkdown } from '../server/lib/ai/transcribe'

const mockChat = vi.mocked(chat)

beforeEach(() => {
  mockChat.mockReset()
})

describe('cleanToMarkdown', () => {
  it('parses clean JSON from chat response', async () => {
    mockChat.mockResolvedValue(JSON.stringify({
      title: 'Meeting Notes Q2',
      markdown: '# Meeting Notes Q2\n\n- Item one\n- Item two\n- [ ] Action item'
    }))

    const result = await cleanToMarkdown('Meeting Notes Q2\nItem one\nItem two\nAction item')
    expect(result.title).toBe('Meeting Notes Q2')
    expect(result.markdown).toContain('# Meeting Notes Q2')
    expect(result.markdown).toContain('- [ ] Action item')
  })

  it('parses fenced JSON (```json ... ```) from chat response', async () => {
    const inner = JSON.stringify({
      title: 'Fenced Title',
      markdown: '## Fenced\n\n1. First\n2. Second'
    })
    mockChat.mockResolvedValue('```json\n' + inner + '\n```')

    const result = await cleanToMarkdown('some raw ocr text')
    expect(result.title).toBe('Fenced Title')
    expect(result.markdown).toContain('## Fenced')
    expect(result.markdown).toContain('1. First')
  })

  it('falls back to raw text when chat returns garbage JSON', async () => {
    mockChat.mockResolvedValue('this is not json at all')

    const raw = 'raw ocr fallback text'
    const result = await cleanToMarkdown(raw)
    expect(result.title).toBe('Transcribed note')
    expect(result.markdown).toBe(raw)
  })

  it('falls back to raw text when chat returns empty markdown', async () => {
    mockChat.mockResolvedValue(JSON.stringify({ title: 'Title', markdown: '   ' }))

    const raw = 'original raw'
    const result = await cleanToMarkdown(raw)
    expect(result.title).toBe('Transcribed note')
    expect(result.markdown).toBe(raw)
  })

  it('falls back to raw text when chat throws', async () => {
    mockChat.mockRejectedValue(new Error('network error'))

    const raw = 'fallback on error'
    const result = await cleanToMarkdown(raw)
    expect(result.title).toBe('Transcribed note')
    expect(result.markdown).toBe(raw)
  })

  it('returns empty-string markdown immediately when raw is empty/whitespace', async () => {
    const result = await cleanToMarkdown('   ')
    expect(result.title).toBe('Transcribed note')
    expect(result.markdown).toBe('   ')
    expect(mockChat).not.toHaveBeenCalled()
  })

  it('uses "Transcribed note" when title field is missing from response', async () => {
    mockChat.mockResolvedValue(JSON.stringify({ markdown: '# Good Markdown\n\nContent here.' }))

    const result = await cleanToMarkdown('some text')
    expect(result.title).toBe('Transcribed note')
    expect(result.markdown).toContain('# Good Markdown')
  })

  it('preserves prose before JSON in model response', async () => {
    const inner = JSON.stringify({
      title: 'Deployment Notes',
      markdown: '# Deployment Notes\n\n- Step one\n- [ ] Verify UAT'
    })
    mockChat.mockResolvedValue('Here is the cleaned output:\n' + inner + '\nDone.')

    const result = await cleanToMarkdown('raw deploy text')
    expect(result.title).toBe('Deployment Notes')
    expect(result.markdown).toContain('- [ ] Verify UAT')
  })
})
