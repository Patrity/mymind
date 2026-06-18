export interface Chunk {
  ord: number
  content: string
  headingPath: string
  charStart: number
  charEnd: number
  tokenCount: number
}

export interface ChunkOptions {
  title?: string | null
  targetTokens?: number   // soft flush target
  maxTokens?: number      // hard cap per chunk
  overlapTokens?: number  // overlap on recursive sub-splits only
}

const CHARS_PER_TOKEN = 3.8
export const estimateTokens = (s: string): number =>
  s.length === 0 ? 0 : Math.ceil(s.length / CHARS_PER_TOKEN)

interface Section { headingPath: string; text: string; charStart: number }

/** Split into sections by markdown headings, fence-aware (headings inside ``` are ignored). */
function splitSections(text: string, title: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  const stack: string[] = [] // heading texts by depth (index = level-1)
  let buf: string[] = []
  let bufStart = 0
  let pos = 0
  let inFence = false

  const breadcrumb = () => [title, ...stack.filter(Boolean)].filter(Boolean).join(' › ')
  const flush = (start: number) => {
    const raw = buf.join('\n')
    const body = raw.trim()
    // `start` points at the first raw buffered char; trim() may strip leading
    // whitespace/blank lines, so shift charStart by the leading-trim offset so
    // it lands on the first real character of the body in the source.
    const leadTrim = raw.length - raw.trimStart().length
    if (body) sections.push({ headingPath: breadcrumb(), text: body, charStart: start + leadTrim })
    buf = []
  }

  for (const line of lines) {
    const fence = /^\s*```/.test(line)
    const heading = !inFence && /^(#{1,6})\s+(.*)$/.exec(line)
    if (fence) inFence = !inFence
    if (heading) {
      flush(bufStart)
      const level = heading[1]!.length
      stack.length = level - 1
      stack[level - 1] = heading[2]!.trim()
      bufStart = pos + line.length + 1
    } else {
      if (buf.length === 0) bufStart = pos
      buf.push(line)
    }
    pos += line.length + 1
  }
  flush(bufStart)
  return sections.length ? sections : [{ headingPath: title, text: text.trim(), charStart: 0 }]
}

/** Segment a section into atomic blocks: paragraphs, but fenced code / tables stay whole. */
function segmentBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let cur: string[] = []
  let inFence = false
  const push = () => { const b = cur.join('\n').trim(); if (b) blocks.push(b); cur = [] }
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const isTable = /^\s*\|.*\|\s*$/.test(line)
    if (!inFence && !isTable && line.trim() === '') { push(); continue }
    cur.push(line)
  }
  push()
  return blocks
}

/** Hard-split a single oversized block by line → sentence → word, ≤ max, with overlap. */
function hardSplit(block: string, max: number, overlap: number): string[] {
  if (estimateTokens(block) <= max) return [block]
  const maxChars = Math.floor(max * CHARS_PER_TOKEN)
  const overlapChars = Math.floor(overlap * CHARS_PER_TOKEN)
  const units = block.split(/(?<=\n)|(?<=[.!?]\s)/)
  const out: string[] = []
  let cur = ''
  for (const u of units) {
    if (cur && (cur.length + u.length) > maxChars) {
      out.push(cur.trim())
      cur = overlapChars > 0 ? cur.slice(-overlapChars) : ''
    }
    cur += u
    while (cur.length > maxChars) { out.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars - overlapChars) }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function chunkMarkdown(text: string, opts: ChunkOptions = {}): Chunk[] {
  const title = (opts.title ?? '').trim()
  const target = opts.targetTokens ?? 300
  const max = opts.maxTokens ?? 512
  const overlap = opts.overlapTokens ?? 32

  const sections = splitSections(text, title)
  const chunks: Chunk[] = []
  let ord = 0

  for (const sec of sections) {
    const pieces: string[] = []
    if (estimateTokens(sec.text) <= max) {
      pieces.push(sec.text)
    } else {
      const blocks = segmentBlocks(sec.text)
      let cur = ''
      for (const block of blocks) {
        const parts = hardSplit(block, max, overlap)
        for (const part of parts) {
          if (cur && estimateTokens(cur + '\n\n' + part) > target) { pieces.push(cur); cur = '' }
          cur = cur ? cur + '\n\n' + part : part
        }
      }
      if (cur.trim()) pieces.push(cur)
    }
    for (const piece of pieces) {
      const rel = sec.text.indexOf(piece.slice(0, 24))
      const charStart = sec.charStart + (rel >= 0 ? rel : 0)
      chunks.push({
        ord: ord++,
        content: piece,
        headingPath: sec.headingPath || title,
        charStart,
        charEnd: charStart + piece.length,
        tokenCount: estimateTokens(piece)
      })
    }
  }
  return chunks
}
