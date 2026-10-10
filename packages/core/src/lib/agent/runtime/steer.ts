// server/lib/agent/runtime/steer.ts
// AI SDK prepareStep may return `messages` for THAT step only; the next step is rebuilt from the
// initial messages plus the model's responses, so an injected message would vanish. Each steer
// is therefore recorded with the index it arrived at and re-spliced on every later step.
// Verified against AI SDK 6.0.198 (node_modules/ai/dist/index.mjs, streamStep): every step
// recomputes `stepInputMessages = [...initialMessages, ...responseMessages]` fresh from the
// model's own accumulated response messages — never from a previous prepareStep call's
// returned `messages` override. See test/run-agent.test.ts > "runAgent — steering via
// prepareStep" for a fake-SDK test that pins this.
export interface SteerMark { at: number; text: string }

export function spliceSteers(messages: unknown[], marks: SteerMark[]): unknown[] {
  const out = [...messages]
  // Later marks first so earlier insertions do not shift the indexes still to apply.
  const sorted = [...marks].map((m, i) => ({ ...m, i })).sort((a, b) => b.at - a.at || b.i - a.i)
  for (const m of sorted) out.splice(Math.min(m.at, out.length), 0, { role: 'user', content: m.text })
  return out
}
