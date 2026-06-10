import { chat, type ChatMessage } from './chat'
import { capTags } from '../../../shared/utils/cap-tags'

export interface VisionResult {
  ocrText: string
  tags: string[]
}

/**
 * Tolerant JSON extractor: strips markdown fences, finds the first {...} block,
 * and JSON.parses it. Returns null on any failure.
 */
function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null
  try {
    let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
    const start = text.indexOf('{')
    if (start === -1) return null
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) return null
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Call the vision endpoint with an image data URL and return OCR text + suggested tags.
 * Uses OpenAI-spec structured content (image_url content part).
 * Never throws — returns { ocrText: '', tags: [] } on any failure.
 */
export async function describeImage(dataUrl: string): Promise<VisionResult> {
  const empty: VisionResult = { ocrText: '', tags: [] }
  try {
    const messages = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Extract ALL text visible in this image using Markdown faithful to the source layout. Preserve headings (#, ##), bullet lists (- ), numbered lists (1. ), checkboxes (- [ ] / - [x]), and bold (**bold**). Do NOT flatten structure into plain paragraphs. Also suggest 5–7 concise lowercase kebab-case tags describing the content (max 10). Respond as STRICT JSON only: {"ocrText": string, "tags": string[]}. No prose.'
          },
          {
            type: 'image_url' as const,
            image_url: { url: dataUrl }
          }
        ]
      }
    ]

    const raw = await chat('vision', messages as ChatMessage[], { temperature: 0.1, maxTokens: 600 })
    const parsed = extractJson(raw)
    if (!parsed) {
      console.warn('[vision] failed to parse JSON from model response:', raw.slice(0, 200))
      return empty
    }

    const ocrText = typeof parsed.ocrText === 'string' ? parsed.ocrText : ''
    const rawTags = Array.isArray(parsed.tags)
      ? (parsed.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    const tags = capTags(rawTags, 10)

    return { ocrText, tags }
  } catch (err) {
    console.warn('[vision] describeImage failed:', err)
    return empty
  }
}
