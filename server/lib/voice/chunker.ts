// server/lib/voice/chunker.ts
// Accumulates streamed text and emits speakable chunks: on sentence-final
// punctuation, or when the buffer passes minChars (so TTS starts before the LLM finishes).
export class SentenceChunker {
  private buf = ''
  constructor(private minChars: number) {}

  push(delta: string): string[] {
    this.buf += delta
    const out: string[] = []
    const re = /[^.!?]*[.!?]+(\s|$)/g
    let m: RegExpExecArray | null
    let consumed = 0
    while ((m = re.exec(this.buf))) {
      const s = m[0].trim()
      if (s) out.push(s)
      consumed = re.lastIndex
    }
    if (consumed) this.buf = this.buf.slice(consumed)
    if (this.buf.trim().length >= this.minChars) {
      out.push(this.buf.trim())
      this.buf = ''
    }
    return out
  }

  flush(): string[] {
    const s = this.buf.trim()
    this.buf = ''
    return s ? [s] : []
  }
}
