// server/lib/agent/toolsets.ts
// Cycle 78: every tool belongs to one toolset. Core sets are always visible to the model; on-demand
// sets are listed in a one-line-each directory and become visible once loaded (load_toolsets, or
// auto-loaded when Bridget calls one of their tools). Visibility only — never availability: the
// full ToolSet is always built, so behaviour, approvals and the headless gate are unchanged.
import type { AgentTool } from './types'

export type ToolsetId = 'memory' | 'docs' | 'tasks' | 'web' | 'core'
  | 'history' | 'projects' | 'doc-admin' | 'images' | 'jobs' | 'skill-admin' | 'reviews' | 'improvements' | 'channels' | 'gmail' | 'calendar'

// Directory lines say WHEN to load the set, not only what is in it (spec §3).
export const TOOLSETS: Record<ToolsetId, { core: boolean; description: string }> = {
  memory: { core: true, description: 'memories' },
  docs: { core: true, description: 'documents' },
  tasks: { core: true, description: 'tasks and quick capture' },
  web: { core: true, description: 'web search and research subagents' },
  core: { core: true, description: 'shell, skills, toolset loading' },
  history: { core: false, description: 'when Tony asks what he did, worked on, or said before — Claude Code sessions and past messages' },
  projects: { core: false, description: 'look up, create or edit projects' },
  'doc-admin': { core: false, description: 'move, delete or sync documents' },
  images: { core: false, description: 'generate a new image or edit the last one' },
  jobs: { core: false, description: 'create, edit, run or schedule background jobs and wake-ups' },
  'skill-admin': { core: false, description: 'create, edit or delete skills' },
  // Neutral on purpose (M5, final review): decide_review is excluded from the headless ToolSet
  // (dangerous — see gate.ts), so a line that promises "decide" is a lie on a wake/job turn. The
  // directory is built from the same gated registry either way (directoryText only lists sets
  // with a tool actually present), so wording here must hold for both the interactive and
  // headless reader.
  reviews: { core: false, description: "when Tony asks about items in his /review queue" },
  improvements: { core: false, description: 'when Tony asks what Bridget has learned or changed about herself' },
  channels: { core: false, description: 'send Tony a message over iMessage or email' },
  gmail: { core: false, description: "when Tony asks about email — search, read, draft, send, triage — or a contact's address" },
  calendar: { core: false, description: 'when Tony asks about his schedule, meetings, availability or invites' }
}

export const ON_DEMAND_TOOLSETS = (Object.keys(TOOLSETS) as ToolsetId[]).filter(id => !TOOLSETS[id].core)

export function isToolsetId(x: unknown): x is ToolsetId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(TOOLSETS, x)
}

/** Stored/declared ids → known on-demand ids. Unknown (renamed/removed) and core ids are dropped. */
export function parseToolsetIds(raw: unknown): ToolsetId[] {
  if (!Array.isArray(raw)) return []
  const out: ToolsetId[] = []
  for (const x of raw) if (isToolsetId(x) && !TOOLSETS[x].core && !out.includes(x)) out.push(x)
  return out
}

export function activeToolNames(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>): string[] {
  return registry.filter(t => TOOLSETS[t.toolset].core || loaded.has(t.toolset)).map(t => t.name)
}

/** `unavailable` (cycle 79): sets whose backing service isn't set up (gmail/calendar with no Google
 *  account connected) are left out of the directory — visibility only; their tools still run if
 *  called and answer with their own "not connected" error. */
export function directoryText(registry: AgentTool[], loaded: ReadonlySet<ToolsetId>, unavailable: ReadonlySet<ToolsetId> = new Set()): string {
  const present = ON_DEMAND_TOOLSETS.filter(id => !unavailable.has(id) && registry.some(t => t.toolset === id))
  if (!present.length) return ''
  return [
    'TOOLSETS — more tools are available on demand. Call `load_toolsets` with the ids you need before using them (calling one of their tools directly also loads it):',
    ...present.map(id => `- ${id} — ${TOOLSETS[id].description}${loaded.has(id) ? ' (loaded)' : ''}`)
  ].join('\n')
}
