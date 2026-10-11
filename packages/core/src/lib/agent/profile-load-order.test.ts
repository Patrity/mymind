// Cycle 81 fix round 1: the workstream tools module must load cleanly whichever module of the agent
// graph is imported FIRST — profile.ts builds its registries from it at load time, and the workstream
// loop's own imports lead back to profile (notify → channels → queue → runner → profile). A static
// import there once left `answerWorkstreamTool` undefined when replay.ts was the entry point.
import { describe, it, expect, vi } from 'vitest'

describe('agent module load order', () => {
  it.each([
    ['tools/workstreams', () => import('./tools/workstreams')],
    ['workstreams/loop', () => import('./workstreams/loop')],
    ['runtime/replay', () => import('./runtime/replay')],
    ['runtime/queue', () => import('./runtime/queue')]
  ])('entry %s: every registry entry is defined', async (_n, entry) => {
    vi.resetModules()
    await entry()
    const { bridgetProfile, workstreamProfile } = await import('./profile')
    for (const t of [...bridgetProfile.tools, ...workstreamProfile.tools]) expect(t?.name).toBeTypeOf('string')
    expect(workstreamProfile.tools.map(t => t.name)).toContain('finish_workstream')
  }, 30_000) // the first entry transforms the whole agent graph cold (~2s alone; > 5s in a loaded full run)
})
