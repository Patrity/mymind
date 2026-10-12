// Cycle 83 Task 1: measure how the dev `reasoning` model holds up as concurrent workstream
// segments pile onto it, to pick the shipped default `maxInFlight` (registry DEFAULT_MAX_IN_FLIGHT).
//
//   node_modules/.bin/tsx --env-file=.env scripts/vllm-ramp.ts [--levels 1,2,4,8,16,24,32] [--max-tokens 256] [--label <model label>]
//
// For each level N it opens N concurrent streaming chat completions of one fixed prompt against
// the head of the `reasoning` chain (or the model labelled --label) and records, per stream, the
// time to first token (any content or reasoning delta) and the decode rate (completion tokens /
// time after the first token). Bounded: each level is cut off at 60 s, and the ramp stops as soon
// as a level's TTFT p95 exceeds 10 s (the knee is behind us). Read-only: nothing is written.
import './lib/core-init'
import { loadConfig } from '@mymind/core/lib/ai/registry/store'
import { resolveChainFrom } from '@mymind/core/lib/ai/registry/resolve'

const LEVEL_TIMEOUT_MS = 60_000
const STOP_TTFT_P95_MS = 10_000
const PROMPT = 'Explain, in about 200 words, how a write-ahead log lets a database recover after a crash. Plain prose, no lists.'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const levels = (arg('levels') ?? '1,2,4,8,16,24,32').split(',').map(Number).filter(n => n > 0)
const maxTokens = Number(arg('max-tokens') ?? 256)

interface Sample { ok: boolean; ttftMs: number | null; tokens: number; decodeMs: number; error?: string }

async function oneStream(url: string, apiKey: string | null, model: string, signal: AbortSignal): Promise<Sample> {
  const started = performance.now()
  let first: number | null = null
  let chunks = 0
  let usageTokens: number | null = null
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model, stream: true, max_tokens: maxTokens, temperature: 0.2,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: PROMPT }]
      })
    })
    if (!res.ok || !res.body) return { ok: false, ttftMs: null, tokens: 0, decodeMs: 0, error: `HTTP ${res.status}` }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let j: { choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }>; usage?: { completion_tokens?: number } }
        try { j = JSON.parse(data) } catch { continue }
        const d = j.choices?.[0]?.delta
        if (d && (d.content || d.reasoning_content || d.reasoning)) {
          first ??= performance.now()
          chunks++
        }
        if (j.usage?.completion_tokens) usageTokens = j.usage.completion_tokens
      }
    }
    const end = performance.now()
    return { ok: true, ttftMs: first === null ? null : first - started, tokens: usageTokens ?? chunks, decodeMs: first === null ? 0 : end - first }
  } catch (err) {
    return { ok: false, ttftMs: first === null ? null : first - started, tokens: usageTokens ?? chunks, decodeMs: first === null ? 0 : performance.now() - first, error: (err as Error).name === 'AbortError' ? 'cut off at 60 s' : (err as Error).message }
  }
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}
const f = (n: number, d = 0) => Number.isFinite(n) ? n.toFixed(d) : '—'

const doc = await loadConfig()
const chain = resolveChainFrom(doc, 'reasoning')
const label = arg('label')
const m = label ? chain.find(x => x.label === label) : chain[0]
if (!m) throw new Error(`no reasoning model labelled "${label}"`)
const url = (m.baseURL ?? '').replace(/\/$/, '')
console.log(`ramp: ${m.label} (${m.modelId}) @ ${url}, max_tokens ${maxTokens}, levels ${levels.join(',')}`)

const rows: string[] = []
rows.push('| N | ok | TTFT p50 (s) | TTFT p95 (s) | tok/s per stream p50 | tok/s per stream min | aggregate tok/s | wall (s) |')
rows.push('|---|---|---|---|---|---|---|---|')
for (const n of levels) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), LEVEL_TIMEOUT_MS)
  const t0 = performance.now()
  const samples = await Promise.all(Array.from({ length: n }, () => oneStream(url, m.apiKey, m.modelId, ac.signal)))
  clearTimeout(timer)
  const wall = performance.now() - t0
  const ttfts = samples.map(s => s.ttftMs).filter((x): x is number => x !== null)
  const rates = samples.filter(s => s.decodeMs > 0 && s.tokens > 1).map(s => (s.tokens - 1) / (s.decodeMs / 1000))
  const total = samples.reduce((a, s) => a + s.tokens, 0)
  const ok = samples.filter(s => s.ok).length
  const row = `| ${n} | ${ok}/${n} | ${f(pct(ttfts, 50) / 1000, 2)} | ${f(pct(ttfts, 95) / 1000, 2)} | ${f(pct(rates, 50), 1)} | ${f(Math.min(...rates), 1)} | ${f(total / (wall / 1000), 1)} | ${f(wall / 1000, 1)} |`
  rows.push(row)
  console.log(row)
  const errs = [...new Set(samples.filter(s => s.error).map(s => s.error))]
  if (errs.length) console.log(`   errors: ${errs.join('; ')}`)
  if (pct(ttfts, 95) > STOP_TTFT_P95_MS || ttfts.length === 0) { console.log(`   stopping: TTFT p95 above ${STOP_TTFT_P95_MS / 1000} s (or no stream produced a token)`); break }
}
console.log(`\n${rows.join('\n')}`)
process.exit(0)
