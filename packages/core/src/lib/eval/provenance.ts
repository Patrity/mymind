// Cycle 85 (spec §3.1/§3.4): what a run is recorded against — the git SHA, the model, the prompt and
// the tool surface — so two runs can be compared knowing what changed between them.
//   git SHA:     MYMIND_GIT_SHA (CD stages it with the worker release) → `git rev-parse HEAD` (dev)
//                → 'unknown'.
//   prompt hash: sha256 of the case's assembled system prompt — the persona, About Tony, the rules,
//                the skills index and the toolset directory the case's first turn sees, at a FIXED
//                clock and with no retrieved context (those vary per turn, not per prompt change).
//                The run's prompt_hash is the sha256 of the per-case hashes (sorted by slug).
//   tools hash:  sha256 of every tool name + description of the chat and workstream registries.
//   model label: the reasoning chain's head (or the run's override), as the registry labels it.
//   gateway:     the origins of the providers of every registry usage an eval run reaches —
//                reasoning, judge, subagents, embeddings and rerank (fix round 1, C3) — the ONLY
//                network an eval world may reach (compared as exact parsed origins). Embeddings are
//                local inside a world today (world.ts fakeEmbed), so that origin is allowed but unused.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { loadConfig } from '../ai/registry/store'
import { evalOverrideChainFrom, resolveChainFrom, resolveJudgeChainFrom, resolveSubagentChainFrom } from '../ai/registry/resolve'
import type { AiConfigDoc, ResolvedModel } from '../ai/registry/types'

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** A fixed clock for the prompt hash (the prompt carries the time of day). */
export const PROMPT_HASH_CLOCK = new Date('2026-01-05T12:00:00Z')

export interface GitShaDeps { env: NodeJS.ProcessEnv; revParse: () => Promise<string | null> }
export const gitShaDeps: GitShaDeps = {
  env: process.env,
  revParse: () => new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { timeout: 5_000 }, (err, stdout) => {
      const sha = String(stdout ?? '').trim()
      resolve(!err && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null)
    })
  })
}

export async function gitSha(d: GitShaDeps = gitShaDeps): Promise<string> {
  const fromEnv = d.env.MYMIND_GIT_SHA?.trim()
  if (fromEnv) return fromEnv
  return (await d.revParse().catch(() => null)) ?? 'unknown'
}

/** sha256 over sorted `name\tdescription` lines of the given tools (deduped by name). */
export function toolsHashOf(tools: Array<{ name: string; description: string }>): string {
  const byName = new Map(tools.map(t => [t.name, `${t.name}\t${t.description}`]))
  return sha256([...byName.keys()].sort().map(k => byName.get(k)!).join('\n'))
}

/** The tool surface an eval case can reach: Bridget's chat registry + a workstream's. */
export async function toolsHash(): Promise<string> {
  const { bridgetProfile, workstreamProfile } = await import('../agent/profile')
  return toolsHashOf([...bridgetProfile.tools, ...workstreamProfile.tools])
}

/** The case's assembled system prompt (its first turn), at PROMPT_HASH_CLOCK, without context. */
export async function casePrompt(c: { prompt: string; surface: string; maxSteps: number }): Promise<string> {
  const [{ buildSystemPrompt }, { bridgetProfile, workstreamProfile }, { directoryText }, { clampBudget }] = await Promise.all([
    import('../agent/prompt'), import('../agent/profile'), import('../agent/toolsets'), import('../agent/workstreams/loop')
  ])
  if (c.surface === 'workstream') {
    const budget = clampBudget({ maxSteps: c.maxSteps })
    return buildSystemPrompt({
      profile: workstreamProfile, speak: false, now: PROMPT_HASH_CLOCK,
      workstream: { goal: c.prompt.trim(), used: { steps: 0, wallMs: 0 }, budget },
      toolsetDirectory: directoryText(workstreamProfile.tools, new Set(['workspace']))
    })
  }
  return buildSystemPrompt({ profile: bridgetProfile, speak: false, now: PROMPT_HASH_CLOCK, toolsetDirectory: directoryText(bridgetProfile.tools, new Set()) })
}

export async function casePromptHash(c: { prompt: string; surface: string; maxSteps: number }): Promise<string> {
  return sha256(await casePrompt(c))
}

/** The run's prompt hash from its cases' (slug → hash). */
export function runPromptHash(perCase: Record<string, string>): string {
  return sha256(Object.keys(perCase).sort().map(k => `${k}\t${perCase[k]}`).join('\n'))
}

function safe(f: () => ResolvedModel[]): ResolvedModel[] {
  try { return f() } catch { return [] }
}

/** The model a run's chat turns try first: the override (a reasoning or subagents model — Task 4 fix
 *  round 1, the same rule as the run's chain), else the reasoning head. */
export function primaryModelFrom(doc: AiConfigDoc, override?: string | null): ResolvedModel | null {
  const chain = safe(() => evalOverrideChainFrom(doc, override))
  return chain[0] ?? null
}

export async function modelLabel(override?: string | null): Promise<string | null> {
  const doc = await loadConfig().catch(() => null)
  if (!doc) return null
  const m = primaryModelFrom(doc, override)
  return m ? m.label : null
}

/** Exact origins (scheme://host:port) of every provider a run uses: reasoning, subagents (children),
 *  judge (the guard, the outcome judge), embeddings, rerank, and the override's provider. Nothing else
 *  (bulk, vision, stt, tts, jev, image endpoints stay blocked). */
export function gatewayOriginsFrom(doc: AiConfigDoc, override?: string | null): Set<string> {
  const models = [
    ...safe(() => resolveChainFrom(doc, 'reasoning')),
    ...safe(() => resolveSubagentChainFrom(doc, null)),
    ...safe(() => resolveJudgeChainFrom(doc)),
    ...safe(() => resolveChainFrom(doc, 'embeddings')),
    ...safe(() => resolveChainFrom(doc, 'rerank'))
  ]
  const urls = models.map(m => m.baseURL)
  if (override) {
    const m = doc.models.find(x => x.id === override)
    const p = m ? doc.providers.find(x => x.id === m.providerId) : undefined
    if (p) urls.push(p.baseURL)
  }
  const out = new Set<string>()
  for (const u of urls) {
    if (!u) continue
    try {
      const o = new URL(u).origin
      if (o && o !== 'null') out.add(o)
    } catch { /* not a URL: nothing allowed for it */ }
  }
  return out
}

/** allowNetwork for a world: true only when the URL's parsed origin is EXACTLY a gateway origin —
 *  never a prefix test (`https://gw@evil.net`, `https://gw.evil.net` must not pass). */
export function gatewayAllow(origins: ReadonlySet<string>): (url: string) => boolean {
  return (url) => {
    try {
      const u = new URL(url)
      if (u.username || u.password) return false
      return origins.has(u.origin)
    } catch { return false }
  }
}
