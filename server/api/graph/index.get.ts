// STUB for P1. Replaced by getGraph() in P2 (Task 2.6).
// Auth-gated by server/middleware/auth.ts (only logged-in sessions/tokens reach here) —
// same implicit guard as events.get.ts and search.get.ts; no explicit call needed here.
import type { GraphData, GraphNode, GraphNodeType, GraphEdge } from '../../../shared/types/graph'

const PROJECTS = ['homelab', 'mymind', 'claude-agent', '2d-rpg', 'bridget', 'copipasta', 'codethis']
const TYPES: GraphNodeType[] = ['memory', 'document', 'image', 'session']
const WEIGHTS = [0.62, 0.13, 0.09, 0.16] // memory-heavy

export default defineEventHandler(async (): Promise<GraphData> => {
  // deterministic PRNG so layout is stable across reloads
  let seed = 1337
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const pick = () => { const r = rnd(); let s = 0; for (let i = 0; i < 4; i++) { s += WEIGHTS[i]!; if (r <= s) return TYPES[i]! } return 'memory' as GraphNodeType }

  const nodes: GraphNode[] = []
  const hubs: GraphNode[] = PROJECTS.map((slug, p) => {
    const a = (p / PROJECTS.length) * Math.PI * 2
    return { type: 'project', id: `proj-${p}`, label: slug, project: slug, projectId: `proj-${p}`,
      x: Math.cos(a) * 0.62, y: (rnd() - 0.5) * 0.3, z: Math.sin(a) * 0.62, degree: 0 }
  })
  const edges: GraphEdge[] = []
  for (let i = 0; i < 230; i++) {
    const p = Math.floor(rnd() * PROJECTS.length), h = hubs[p]!
    const rr = Math.pow(rnd(), 0.7) * 0.34, a = rnd() * Math.PI * 2, b = Math.acos(2 * rnd() - 1)
    const t = pick()
    const id = `${t}-${i}`
    nodes.push({ type: t, id, label: `${t} #${i}`, preview: `Stub ${t} node ${i}`, project: PROJECTS[p]!, projectId: `proj-${p}`,
      x: h.x + rr * Math.sin(b) * Math.cos(a), y: h.y + rr * Math.cos(b) * 0.7, z: h.z + rr * Math.sin(b) * Math.sin(a), degree: 1 })
    edges.push({ from: { type: t, id }, to: { type: 'project', id: h.id }, kind: 'membership' })
    h.degree++
  }
  // a few memory↔memory relations
  const mem = nodes.filter(n => n.type === 'memory')
  for (let k = 0; k < 10; k++) {
    const a = mem[Math.floor(rnd() * mem.length)]!, b = mem[Math.floor(rnd() * mem.length)]!
    if (a !== b) edges.push({ from: { type: 'memory', id: a.id }, to: { type: 'memory', id: b.id }, kind: rnd() < 0.6 ? 'supersedes' : 'contradicts' })
  }
  return { nodes: [...nodes, ...hubs], edges }
})
