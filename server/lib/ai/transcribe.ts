import { chat } from './chat'

/**
 * Tolerant JSON extractor: strips markdown fences, finds the first {...} block,
 * JSON.parses it. Returns null on any failure.
 */
function extractJson(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null
  try {
    const text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
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

const SYS = 'You convert raw OCR text from a (possibly handwritten) note into clean, faithful Markdown. Preserve structure: headings (#), bullet lists (- ), numbered lists, checkboxes (- [ ]), bold (**). Do NOT invent content; fix obvious OCR artifacts. Infer a concise human title. Output STRICT JSON only: {"title": string, "markdown": string}.'

/**
 * Clean raw OCR text into tidy Markdown and infer a human title using the
 * reasoning model. Never throws — always returns something usable (falls back
 * to the raw text on any failure).
 */
export async function cleanToMarkdown(raw: string): Promise<{ title: string, markdown: string }> {
  if (!raw.trim()) return { title: 'Transcribed note', markdown: raw }

  try {
    const out = await chat(
      'reasoning',
      [
        { role: 'system', content: SYS },
        { role: 'user', content: raw }
      ],
      { temperature: 0.2, maxTokens: 1500 }
    )

    const parsed = extractJson(out)
    if (parsed && typeof parsed.markdown === 'string' && parsed.markdown.trim()) {
      return {
        title: (parsed.title && typeof parsed.title === 'string' && parsed.title.trim())
          ? parsed.title.trim()
          : 'Transcribed note',
        markdown: parsed.markdown
      }
    }
  } catch (e) {
    console.warn('[transcribe] cleanToMarkdown AI call failed:', e)
  }

  return { title: 'Transcribed note', markdown: raw }
}
