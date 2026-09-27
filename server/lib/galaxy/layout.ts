import { UMAP } from 'umap-js'

export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) return []
  const dim = vectors[0]!.length
  const out = new Array(dim).fill(0)
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]!
  for (let i = 0; i < dim; i++) out[i] /= vectors.length
  return out
}

export interface LayoutItem { type: string; id: string; vector: number[] }
export interface LayoutRow { type: string; id: string; x: number; y: number; z: number }

// seeded PRNG + UMAP instance, shared by computeLayout and computeLayoutAsync so both
// produce byte-identical embeddings for the same seed.
function makeUmap(items: LayoutItem[], seed: number): UMAP {
  let s = seed >>> 0
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  return new UMAP({ nComponents: 3, nNeighbors: Math.min(15, items.length - 1), minDist: 0.1, random })
}

// unit-cube normalisation + row mapping, shared by computeLayout and computeLayoutAsync.
function normalize(items: LayoutItem[], embedding: number[][]): LayoutRow[] {
  let max = 1e-6
  for (const e of embedding) for (const c of e) max = Math.max(max, Math.abs(c))
  return items.map((it, i) => {
    const e = embedding[i]!
    return { type: it.type, id: it.id, x: e[0]! / max, y: e[1]! / max, z: e[2]! / max }
  })
}

export function computeLayout(items: LayoutItem[], seed = 42): LayoutRow[] {
  if (items.length === 0) return []
  // UMAP needs nNeighbors >= 1, i.e. at least 2 points; a single point has no
  // relative position to compute, so place it at the origin.
  if (items.length === 1) {
    const it = items[0]!
    return [{ type: it.type, id: it.id, x: 0, y: 0, z: 0 }]
  }
  const umap = makeUmap(items, seed)
  const embedding = umap.fit(items.map(i => i.vector))
  return normalize(items, embedding)
}

/** Same result as computeLayout, but yields to the event loop between optimisation epochs so a
 *  streaming agent turn is not frozen for the whole fit. The nearest-neighbour init
 *  (initializeFit) is still one synchronous block — see the measurement in the cycle-73 handover. */
export async function computeLayoutAsync(items: LayoutItem[], seed = 42, opts: { yieldEvery?: number } = {}): Promise<LayoutRow[]> {
  if (items.length === 0) return []
  if (items.length === 1) return computeLayout(items, seed)
  const umap = makeUmap(items, seed)
  const nEpochs = umap.initializeFit(items.map(i => i.vector))
  const every = opts.yieldEvery ?? 10
  for (let i = 0; i < nEpochs; i++) {
    umap.step()
    if (i % every === 0) await new Promise(r => setImmediate(r))
  }
  return normalize(items, umap.getEmbedding())
}
