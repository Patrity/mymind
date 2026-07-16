// app/lib/galaxy/scene.ts
//
// Knowledge Galaxy — three.js scene controller.
//
// A faithful three.js port of the validated canvas-2D prototype
// (.superpowers/brainstorm/38822-1784166080/content/galaxy-page-v5.html).
// The prototype rotates the *world* by a quaternion and projects through a
// fixed-distance perspective (zoom changes magnification, not dolly). We
// reproduce that exactly: a THREE.Group carries the arcball quaternion, and a
// fixed-distance PerspectiveCamera whose fov is derived each frame so the
// projected galaxy radius equals the arcball radius R — that keeps the
// grab-the-point-under-the-cursor feel identical to the prototype.
//
// Composer / bloom wiring mirrors app/lib/viz/scene.ts.
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import type { GraphData, GraphNode, GraphNodeType, GraphEdgeKind } from '~~/shared/types/graph'
import { qMul, qAxis, qConj, qFromTo, angleOf, decayQ, mapSphere, type Quat } from './arcball'
import { makeSpring, stepSpring, type Spring } from './spring'

// ---------------------------------------------------------------------------
// Public interface (later tasks depend on these EXACT names/signatures)
// ---------------------------------------------------------------------------
export interface GalaxyControlsState {
  spread: number
  zoom: number
  rotate: number
  size: number
  glow: number
  link: number
}

export interface GalaxyScene {
  setData(data: GraphData): void
  setColorMode(mode: 'type' | 'project'): void
  /** Legend toggles — the set holds the *disabled* keys (type name, or project slug in project mode). */
  setVisibleKeys(disabled: Set<string>): void
  /** Slider targets — sprung toward each frame. */
  setControls(partial: Partial<GalaxyControlsState>): void
  flyTo(nodeId: string): void
  onHover(cb: (node: GraphNode | null) => void): void
  onSelect(cb: (node: GraphNode) => void): void
  select(nodeId: string | null): void
  /** Eases the horizontal centre so the galaxy clears the detail pane. */
  setDetailOpen(open: boolean): void
  /**
   * Temporarily emphasise a set of nodes and draw links from the first id
   * (anchor) to the rest — powers "Show similar". Emphasised nodes swell and
   * stay full-opacity; everything else dims so the neighbours pop. Auto-clears
   * after a few seconds. Pass `[]` to clear immediately.
   */
  highlight(ids: string[]): void
  dispose(): void
}

// ---------------------------------------------------------------------------
// Palette + tuning (matches the prototype)
// ---------------------------------------------------------------------------
const TYPE_COLOR: Record<GraphNodeType, number> = {
  memory: 0xa78bfa,
  document: 0x60a5fa,
  image: 0xfbbf24,
  session: 0x34d399,
  project: 0xf472b6,
}

// Deterministic per-project hues (project colour mode + project hubs).
const PROJECT_HUES = [
  0xf472b6, 0xa78bfa, 0x60a5fa, 0x34d399, 0xfbbf24, 0xfb7185, 0x22d3ee,
  0xc084fc, 0x38bdf8, 0xfacc15, 0xf87171, 0x4ade80,
]

// Edge colour + base opacity by kind (membership faint grey; supersedes violet;
// contradicts red; provenance/ocr ride the faint-grey membership channel).
const EDGE_STYLE: Record<GraphEdgeKind, { color: number; op: number; strong: boolean }> = {
  membership: { color: 0x96a0d2, op: 0.11, strong: false },
  provenance: { color: 0x96a0d2, op: 0.11, strong: false },
  ocr: { color: 0x96a0d2, op: 0.1, strong: false },
  supersedes: { color: 0xa78bfa, op: 0.5, strong: true },
  contradicts: { color: 0xfb7185, op: 0.5, strong: true },
}

const DETAIL_W = 372 // detail-pane width the centre eases around (prototype)
const CAM_D = 2.4 // fixed camera distance (prototype perspective constant ≈ 2.2)
const POINT_PX = 7.0 // gl_PointSize scale → css diameter ≈ aSize * POINT_PX / depth
const HOVER_PX = 15 // screen-space hover pickup radius (prototype ≈ 16)
const HUB_SIZE = 3.6 // project-hub sprite base size (bigger + brighter)
const BLOOM_BASE = 0.85 // UnrealBloom strength at glow = 1

// Slider clamp ranges (mirror the prototype's <input> min/max).
const CLAMP: Record<keyof GalaxyControlsState, [number, number]> = {
  spread: [0.5, 1.9],
  zoom: [0.5, 2.6],
  rotate: [0, 4],
  size: [0.5, 2],
  glow: [0.3, 1.8],
  link: [0, 1.6],
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

// ---------------------------------------------------------------------------
// Sprite textures (soft additive disc + selection ring)
// ---------------------------------------------------------------------------
function discTexture(): THREE.Texture {
  const s = 64
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function ringTexture(): THREE.Texture {
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')!
  g.strokeStyle = 'rgba(255,255,255,0.95)'
  g.lineWidth = 3
  g.beginPath()
  g.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2)
  g.stroke()
  g.strokeStyle = 'rgba(167,139,250,0.6)'
  g.lineWidth = 3
  g.beginPath()
  g.arc(s / 2, s / 2, s * 0.44, 0, Math.PI * 2)
  g.stroke()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createGalaxyScene(canvas: HTMLCanvasElement): GalaxyScene {
  let cssW = canvas.clientWidth || 800
  let cssH = canvas.clientHeight || 600

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, cssW / cssH, 0.1, 100)
  camera.position.set(0, 0, CAM_D)
  camera.lookAt(0, 0, 0)

  // `world` carries the arcball quaternion; every node/edge is a child, so the
  // group transform reproduces the prototype's vRot(p, q) exactly.
  const world = new THREE.Group()
  scene.add(world)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' })
  let ratio = Math.min(window.devicePixelRatio || 1, 2)
  renderer.setPixelRatio(ratio)
  renderer.setSize(cssW, cssH, false)
  renderer.setClearColor(0x05060c, 1)

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(ratio)
  composer.addPass(new RenderPass(scene, camera))
  // threshold=0.2 (not 0): at 0 every near-black background texel + faint additive
  // edge blending enters the bloom convolution, and with ~230 points in frame that
  // floods the whole canvas into a lavender haze instead of a dark backdrop with
  // isolated glows. Tuned live in the browser (Task 1.6) against the prototype.
  const bloom = new UnrealBloomPass(new THREE.Vector2(cssW, cssH), BLOOM_BASE, 0.55, 0.2)
  composer.addPass(bloom)

  // --- point material (custom shader: per-node size + colour + alpha) ------
  const disc = discTexture()
  const pointMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: disc },
      uSize: { value: 1 }, // size control
      uScale: { value: ratio * POINT_PX }, // px scale (DPR-aware, viewport-independent)
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uSize;
      uniform float uScale;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uSize * uScale / max(0.05, -mv.z);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float a = texture2D(uTex, gl_PointCoord).a;
        if (a < 0.01 || vAlpha <= 0.0) discard;
        gl_FragColor = vec4(vColor * vAlpha, a * vAlpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  })

  const pointGeo = new THREE.BufferGeometry()
  const points = new THREE.Points(pointGeo, pointMat)
  points.frustumCulled = false
  world.add(points)

  // --- edge line segments (faint membership + strong structural) -----------
  const faintMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })
  const strongMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })
  const faintGeo = new THREE.BufferGeometry()
  const strongGeo = new THREE.BufferGeometry()
  const faintLines = new THREE.LineSegments(faintGeo, faintMat)
  const strongLines = new THREE.LineSegments(strongGeo, strongMat)
  faintLines.frustumCulled = false
  strongLines.frustumCulled = false
  world.add(faintLines)
  world.add(strongLines)

  // --- "Show similar" highlight links (anchor → neighbours, warm gold) ------
  const highlightMat = new THREE.LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false })
  const highlightGeo = new THREE.BufferGeometry()
  const highlightLines = new THREE.LineSegments(highlightGeo, highlightMat)
  highlightLines.frustumCulled = false
  world.add(highlightLines)

  // --- selection ring (billboard sprite, lives in scene not world) ---------
  const ringTex = ringTexture()
  const ringMat = new THREE.SpriteMaterial({ map: ringTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending })
  const ring = new THREE.Sprite(ringMat)
  ring.visible = false
  scene.add(ring)

  // -------------------------------------------------------------------------
  // Data model (cached layout; spread transforms cached coords, not a relayout)
  // -------------------------------------------------------------------------
  let nodes: GraphNode[] = []
  const idIndex = new Map<string, number>()
  const projectColor = new Map<string, number>() // project key → hue
  let cX = new Float32Array(0), cY = new Float32Array(0), cZ = new Float32Array(0) // centroid per node
  let oX = new Float32Array(0), oY = new Float32Array(0), oZ = new Float32Array(0) // offset per node
  let baseSize = new Float32Array(0)
  let isHub: boolean[] = []
  let posArr = new Float32Array(0) // live world-local positions (centroid + offset*spread)
  let colArr = new Float32Array(0)
  let sizeArr = new Float32Array(0)
  let alphaArr = new Float32Array(0)
  type EdgePair = { a: number; b: number; kind: GraphEdgeKind }
  let edges: EdgePair[] = []

  // controls (springs) ------------------------------------------------------
  const springs: Record<keyof GalaxyControlsState, Spring> = {
    spread: makeSpring(1.0),
    zoom: makeSpring(0.9),
    rotate: makeSpring(1.0),
    size: makeSpring(1.0),
    glow: makeSpring(1.0),
    link: makeSpring(1.0),
  }
  let lastSpread = 1.0

  // camera orientation + interaction state ----------------------------------
  let q: Quat = qMul(qAxis(1, 0, 0, 0.42), qAxis(0, 1, 0, 0.4)) // pleasant starting tilt
  let qPrevFrame: Quat = q
  let qStart: Quat = q
  let spin: Quat | null = null
  let inertia = false
  let dragging = false
  let arc0 = { x: 0, y: 0, z: 1 }
  let downX = 0, downY = 0, moved = 0
  let mouseX = -999, mouseY = -999
  let lastInteract = -1e9
  let cxCur = cssW / 2
  let detailOpen = false

  let colorMode: 'type' | 'project' = 'type'
  let disabledKeys = new Set<string>()
  let selectedId: string | null = null
  // "Show similar" transient highlight (anchor id first, then neighbours).
  let highlightSet = new Set<string>()
  let highlightPairs: { a: number; b: number }[] = []
  let highlightUntil = 0
  const HIGHLIGHT_MS = 6500
  let hoverNode: GraphNode | null = null
  let onHoverCb: ((n: GraphNode | null) => void) | null = null
  let onSelectCb: ((n: GraphNode) => void) | null = null

  // fly-to tween ------------------------------------------------------------
  let flyActive = false
  let flyT0 = 0
  const flyDur = 750
  const flyFrom = new THREE.Quaternion()
  const flyTo3 = new THREE.Quaternion()
  const flyTmp = new THREE.Quaternion()

  const _v = new THREE.Vector3()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const mark = () => { lastInteract = now() }
  const focalPx = () => Math.min(cssW, cssH) * 0.5 * springs.zoom.c

  // -------------------------------------------------------------------------
  // Keys + colour helpers
  // -------------------------------------------------------------------------
  const projKey = (n: GraphNode) => n.project ?? '__none__'
  const legendKey = (n: GraphNode) => (colorMode === 'type' ? n.type : projKey(n))
  const nodeVisible = (n: GraphNode) => !disabledKeys.has(legendKey(n))
  const rgb = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]

  function nodeHue(n: GraphNode): number {
    if (n.type === 'project') return projectColor.get(projKey(n)) ?? PROJECT_HUES[0]!
    return colorMode === 'type' ? TYPE_COLOR[n.type] : (projectColor.get(projKey(n)) ?? 0x9aa0b8)
  }

  // -------------------------------------------------------------------------
  // setData — build cached layout, centroids, buffers, edge list
  // -------------------------------------------------------------------------
  function setData(data: GraphData) {
    nodes = data.nodes
    const n = nodes.length
    idIndex.clear()
    projectColor.clear()
    isHub = new Array(n).fill(false)
    cX = new Float32Array(n); cY = new Float32Array(n); cZ = new Float32Array(n)
    oX = new Float32Array(n); oY = new Float32Array(n); oZ = new Float32Array(n)
    baseSize = new Float32Array(n)
    posArr = new Float32Array(n * 3)
    colArr = new Float32Array(n * 3)
    sizeArr = new Float32Array(n)
    alphaArr = new Float32Array(n)

    nodes.forEach((node, i) => idIndex.set(node.id, i))

    // Assign deterministic project hues (sorted for stability across reloads).
    const slugs = Array.from(new Set(nodes.map(projKey))).sort()
    slugs.forEach((s, i) => projectColor.set(s, PROJECT_HUES[i % PROJECT_HUES.length]!))

    // Project-hub centroids: prefer the project node's own position, else the
    // mean of its members.
    const hubPos = new Map<string, { x: number; y: number; z: number }>()
    const acc = new Map<string, { x: number; y: number; z: number; c: number }>()
    for (const node of nodes) {
      const k = projKey(node)
      if (node.type === 'project') hubPos.set(k, { x: node.x, y: node.y, z: node.z })
      const a = acc.get(k) ?? { x: 0, y: 0, z: 0, c: 0 }
      a.x += node.x; a.y += node.y; a.z += node.z; a.c++
      acc.set(k, a)
    }
    const centroidOf = (k: string) => {
      if (hubPos.has(k)) return hubPos.get(k)!
      const a = acc.get(k)
      if (a && a.c > 0) return { x: a.x / a.c, y: a.y / a.c, z: a.z / a.c }
      return { x: 0, y: 0, z: 0 }
    }

    nodes.forEach((node, i) => {
      const hub = node.type === 'project'
      isHub[i] = hub
      const c = node.project === null && !hub ? { x: 0, y: 0, z: 0 } : centroidOf(projKey(node))
      cX[i] = c.x; cY[i] = c.y; cZ[i] = c.z
      oX[i] = node.x - c.x; oY[i] = node.y - c.y; oZ[i] = node.z - c.z
      // size ∝ sqrt(degree) × size control; hubs larger.
      baseSize[i] = hub ? HUB_SIZE + Math.sqrt(node.degree + 1) * 0.4 : Math.min(4, Math.sqrt(node.degree + 1))
    })

    // Structural + membership edges from the graph (skip missing endpoints).
    edges = []
    for (const e of data.edges) {
      const a = idIndex.get(e.from.id)
      const b = idIndex.get(e.to.id)
      if (a === undefined || b === undefined) continue
      edges.push({ a, b, kind: e.kind })
    }

    refreshColors()
    refreshAlphas()
    writePositions(true) // seed positions from spread = current
    rebuildEdges()

    pointGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3).setUsage(THREE.DynamicDrawUsage))
    pointGeo.setAttribute('aColor', new THREE.BufferAttribute(colArr, 3))
    pointGeo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1))
    pointGeo.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArr, 1).setUsage(THREE.DynamicDrawUsage))
    pointGeo.computeBoundingSphere()

    // Keep selection if it still exists, else clear.
    if (selectedId !== null && !idIndex.has(selectedId)) selectedId = null
  }

  // live world-local positions from cached centroid + offset*spread ---------
  function writePositions(force = false) {
    const spread = springs.spread.c
    if (!force && Math.abs(spread - lastSpread) < 1e-4) return
    lastSpread = spread
    for (let i = 0; i < nodes.length; i++) {
      posArr[i * 3] = cX[i]! + oX[i]! * spread
      posArr[i * 3 + 1] = cY[i]! + oY[i]! * spread
      posArr[i * 3 + 2] = cZ[i]! + oZ[i]! * spread
    }
    const attr = pointGeo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (attr) attr.needsUpdate = true
    writeEdgePositions()
  }

  function refreshColors() {
    for (let i = 0; i < nodes.length; i++) {
      const [r, g, b] = rgb(nodeHue(nodes[i]!))
      colArr[i * 3] = r; colArr[i * 3 + 1] = g; colArr[i * 3 + 2] = b
    }
    const attr = pointGeo.getAttribute('aColor') as THREE.BufferAttribute | undefined
    if (attr) attr.needsUpdate = true
  }

  function refreshAlphas() {
    const hot = highlightSet.size > 0
    for (let i = 0; i < nodes.length; i++) {
      const vis = nodeVisible(nodes[i]!)
      let alpha = vis ? (isHub[i] ? 1.0 : 0.85) : 0
      let size = baseSize[i]!
      if (hot && vis) {
        if (highlightSet.has(nodes[i]!.id)) { alpha = 1.0; size = baseSize[i]! * 1.7 }
        else alpha *= 0.32 // dim the rest so the neighbours pop
      }
      alphaArr[i] = alpha
      sizeArr[i] = size
    }
    const a = pointGeo.getAttribute('aAlpha') as THREE.BufferAttribute | undefined
    if (a) a.needsUpdate = true
    const s = pointGeo.getAttribute('aSize') as THREE.BufferAttribute | undefined
    if (s) s.needsUpdate = true
  }

  // Rebuild edge geometry, keeping only edges whose endpoints are both visible.
  let faintPairs: EdgePair[] = []
  let strongPairs: EdgePair[] = []
  function rebuildEdges() {
    faintPairs = []
    strongPairs = []
    for (const e of edges) {
      if (!nodeVisible(nodes[e.a]!) || !nodeVisible(nodes[e.b]!)) continue
      ;(EDGE_STYLE[e.kind].strong ? strongPairs : faintPairs).push(e)
    }
    buildEdgeGeo(faintGeo, faintPairs)
    buildEdgeGeo(strongGeo, strongPairs)
    writeEdgePositions()
  }

  function buildEdgeGeo(geo: THREE.BufferGeometry, pairs: EdgePair[]) {
    const pos = new Float32Array(pairs.length * 6)
    const col = new Float32Array(pairs.length * 6)
    pairs.forEach((e, i) => {
      const [r, g, b] = rgb(EDGE_STYLE[e.kind].color)
      for (const off of [0, 3]) { col[i * 6 + off] = r; col[i * 6 + off + 1] = g; col[i * 6 + off + 2] = b }
    })
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geo.computeBoundingSphere()
  }

  function writeEdgePositions() {
    writePairs(faintGeo, faintPairs)
    writePairs(strongGeo, strongPairs)
    writePairs(highlightGeo, highlightPairs as EdgePair[])
  }
  function writePairs(geo: THREE.BufferGeometry, pairs: EdgePair[]) {
    const attr = geo.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!attr) return
    const arr = attr.array as Float32Array
    pairs.forEach((e, i) => {
      arr[i * 6] = posArr[e.a * 3]!; arr[i * 6 + 1] = posArr[e.a * 3 + 1]!; arr[i * 6 + 2] = posArr[e.a * 3 + 2]!
      arr[i * 6 + 3] = posArr[e.b * 3]!; arr[i * 6 + 4] = posArr[e.b * 3 + 1]!; arr[i * 6 + 5] = posArr[e.b * 3 + 2]!
    })
    attr.needsUpdate = true
  }

  // "Show similar" highlight — (re)allocate the anchor→neighbour line buffer.
  function buildHighlightGeo() {
    const pos = new Float32Array(highlightPairs.length * 6)
    highlightGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage))
    highlightGeo.computeBoundingSphere()
  }

  function clearHighlight() {
    if (highlightSet.size === 0 && highlightPairs.length === 0) return
    highlightSet = new Set()
    highlightPairs = []
    highlightUntil = 0
    buildHighlightGeo()
    refreshAlphas()
  }

  function highlight(ids: string[]) {
    // Keep only ids that map to a currently-visible node.
    const valid = ids.filter((id) => {
      const idx = idIndex.get(id)
      return idx !== undefined && nodeVisible(nodes[idx]!)
    })
    if (valid.length === 0) { clearHighlight(); return }
    highlightSet = new Set(valid)
    const anchor = idIndex.get(valid[0]!)
    highlightPairs = []
    if (anchor !== undefined) {
      for (let i = 1; i < valid.length; i++) {
        const b = idIndex.get(valid[i]!)
        if (b !== undefined) highlightPairs.push({ a: anchor, b })
      }
    }
    highlightUntil = now() + HIGHLIGHT_MS
    buildHighlightGeo()
    writePairs(highlightGeo, highlightPairs as EdgePair[])
    refreshAlphas()
    mark()
  }

  // -------------------------------------------------------------------------
  // Pointer + wheel interaction (arcball grab / drag-throw / scroll-zoom)
  // -------------------------------------------------------------------------
  function localXY(e: PointerEvent | WheelEvent) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: PointerEvent) => {
    dragging = true
    inertia = false
    spin = null
    flyActive = false
    qPrevFrame = q
    qStart = q
    const p = localXY(e)
    downX = e.clientX; downY = e.clientY; moved = 0
    arc0 = mapSphere(p.x, p.y, cxCur, cssH / 2, focalPx())
    canvas.style.cursor = 'grabbing'
    mark()
  }

  const onPointerMove = (e: PointerEvent) => {
    const p = localXY(e)
    mouseX = p.x; mouseY = p.y
    if (dragging) {
      moved = Math.hypot(e.clientX - downX, e.clientY - downY)
      const v1 = mapSphere(p.x, p.y, cxCur, cssH / 2, focalPx())
      q = qMul(qFromTo(arc0, v1), qStart)
      mark()
    }
  }

  const onPointerUp = () => {
    if (!dragging) return
    dragging = false
    canvas.style.cursor = 'grab'
    if (moved < 5) {
      // click → select the hovered node (if any)
      if (hoverNode) select(hoverNode.id)
    } else if (spin && angleOf(spin) > 0.002) {
      inertia = true // drag & throw → keep spinning
    }
    mark()
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    springs.zoom.t = clamp(springs.zoom.t * (1 - e.deltaY * 0.0012), CLAMP.zoom[0], CLAMP.zoom[1])
    mark()
  }

  canvas.style.cursor = 'grab'
  canvas.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  // WebGL context loss (mirror app/lib/viz) ---------------------------------
  const onContextLost = (e: Event) => { e.preventDefault(); running = false }
  const onContextRestored = () => { if (!disposed) { running = true; loop() } }
  canvas.addEventListener('webglcontextlost', onContextLost)
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  // DPR-aware resize --------------------------------------------------------
  const doResize = () => {
    const w = canvas.clientWidth || cssW
    const h = canvas.clientHeight || cssH
    if (w === cssW && h === cssH) return
    cssW = w; cssH = h
    ratio = Math.min(window.devicePixelRatio || 1, 2)
    renderer.setPixelRatio(ratio)
    renderer.setSize(cssW, cssH, false)
    composer.setPixelRatio(ratio)
    composer.setSize(cssW, cssH)
    bloom.setSize(cssW, cssH)
    pointMat.uniforms.uScale!.value = ratio * POINT_PX
    camera.aspect = cssW / cssH
    camera.updateProjectionMatrix()
  }
  const ro = new ResizeObserver(doResize)
  ro.observe(canvas)
  window.addEventListener('resize', doResize)

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------
  function setColorMode(mode: 'type' | 'project') {
    colorMode = mode
    refreshColors()
    refreshAlphas()
    rebuildEdges()
  }

  function setVisibleKeys(disabled: Set<string>) {
    disabledKeys = new Set(disabled)
    refreshAlphas()
    rebuildEdges()
    if (selectedId !== null) {
      const idx = idIndex.get(selectedId)
      if (idx !== undefined && !nodeVisible(nodes[idx]!)) ring.visible = false
    }
  }

  function setControls(partial: Partial<GalaxyControlsState>) {
    for (const key of Object.keys(partial) as (keyof GalaxyControlsState)[]) {
      const v = partial[key]
      if (typeof v !== 'number' || Number.isNaN(v)) continue
      springs[key].t = clamp(v, CLAMP[key][0], CLAMP[key][1])
    }
    mark()
  }

  function select(nodeId: string | null) {
    selectedId = nodeId
    if (nodeId === null) { ring.visible = false; return }
    const idx = idIndex.get(nodeId)
    if (idx === undefined) { selectedId = null; ring.visible = false; return }
    onSelectCb?.(nodes[idx]!)
    mark()
  }

  function flyTo(nodeId: string) {
    const idx = idIndex.get(nodeId)
    if (idx === undefined) return
    // Bring the node's direction to the front (+Z, toward the camera).
    const spread = springs.spread.c
    const wx = cX[idx]! + oX[idx]! * spread
    const wy = cY[idx]! + oY[idx]! * spread
    const wz = cZ[idx]! + oZ[idx]! * spread
    const len = Math.hypot(wx, wy, wz) || 1
    const target = qFromTo({ x: wx / len, y: wy / len, z: wz / len }, { x: 0, y: 0, z: 1 })
    flyFrom.set(q.x, q.y, q.z, q.w)
    flyTo3.set(target.x, target.y, target.z, target.w)
    flyActive = true
    flyT0 = now()
    inertia = false
    spin = null
    springs.zoom.t = clamp(Math.max(springs.zoom.t, 1.4), CLAMP.zoom[0], CLAMP.zoom[1])
    select(nodeId)
    mark()
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------
  let raf = 0
  let running = true
  let disposed = false

  function updateCamera() {
    // fov so the projected galaxy radius equals R = focalPx (arcball tracking).
    const tanHalf = clamp((cssH * 0.5) / (CAM_D * Math.max(1, focalPx())), Math.tan((8 * Math.PI) / 360), Math.tan((70 * Math.PI) / 360))
    camera.fov = (2 * Math.atan(tanHalf) * 180) / Math.PI
    camera.updateProjectionMatrix()
  }

  function updateRing() {
    if (selectedId === null) { ring.visible = false; return }
    const idx = idIndex.get(selectedId)
    if (idx === undefined || !nodeVisible(nodes[idx]!)) { ring.visible = false; return }
    _v.set(posArr[idx * 3]!, posArr[idx * 3 + 1]!, posArr[idx * 3 + 2]!).applyMatrix4(world.matrixWorld)
    ring.position.copy(_v)
    const depth = Math.max(0.1, camera.position.z - _v.z)
    ring.scale.setScalar(0.05 + baseSize[idx]! * 0.02 + depth * 0.03)
    ring.visible = true
  }

  function updateHover() {
    if (dragging) return
    let best = -1
    let bd = HOVER_PX
    for (let i = 0; i < nodes.length; i++) {
      if (alphaArr[i] === 0) continue
      _v.set(posArr[i * 3]!, posArr[i * 3 + 1]!, posArr[i * 3 + 2]!).applyMatrix4(world.matrixWorld).project(camera)
      if (_v.z > 1) continue
      const sx = (_v.x * 0.5 + 0.5) * cssW
      const sy = (-_v.y * 0.5 + 0.5) * cssH
      const d = Math.hypot(sx - mouseX, sy - mouseY)
      const pick = isHub[i] ? bd + 4 : bd
      if (d < pick) { bd = d; best = i }
    }
    const hn = best >= 0 ? nodes[best]! : null
    if (hn !== hoverNode) {
      hoverNode = hn
      onHoverCb?.(hn)
    }
    if (!dragging) canvas.style.cursor = hn ? 'pointer' : 'grab'
  }

  function loop() {
    if (!running) return
    raf = requestAnimationFrame(loop)

    // expire the transient "Show similar" highlight
    if (highlightUntil && now() > highlightUntil) clearHighlight()

    // step control springs
    stepSpring(springs.spread); stepSpring(springs.zoom); stepSpring(springs.rotate)
    stepSpring(springs.size); stepSpring(springs.glow); stepSpring(springs.link)

    // ease horizontal centre for the detail pane
    const cxTarget = detailOpen ? (cssW - DETAIL_W) / 2 : cssW / 2
    cxCur += (cxTarget - cxCur) * 0.12

    // rotation: fly-tween > drag > inertia > idle auto-rotate
    if (flyActive) {
      const t = clamp((now() - flyT0) / flyDur, 0, 1)
      flyTmp.copy(flyFrom).slerp(flyTo3, easeInOut(t))
      q = { x: flyTmp.x, y: flyTmp.y, z: flyTmp.z, w: flyTmp.w }
      if (t >= 1) flyActive = false
    } else if (dragging) {
      spin = qMul(q, qConj(qPrevFrame)) // capture angular velocity
    } else if (inertia && spin) {
      q = qMul(spin, q)
      spin = decayQ(spin, 0.94)
      if (angleOf(spin) < 0.0009) { inertia = false; spin = null }
    } else if (now() - lastInteract > 2000) {
      q = qMul(qAxis(0, 1, 0, 0.0016 * springs.rotate.c), q) // idle auto-rotate
    }
    qPrevFrame = q

    // apply transform to the world group
    world.quaternion.set(q.x, q.y, q.z, q.w)
    world.position.x = (cxCur - cssW / 2) / focalPx() // pan for detail pane
    world.updateMatrixWorld(true)

    // spread changes → rewrite node + edge positions
    writePositions()

    // camera + uniforms
    updateCamera()
    pointMat.uniforms.uSize!.value = springs.size.c
    bloom.strength = BLOOM_BASE * springs.glow.c
    const link = springs.link.c
    faintMat.opacity = clamp(0.11 * link, 0, 1)
    strongMat.opacity = clamp(0.5 * link, 0, 1)

    updateRing()
    updateHover()

    composer.render()
  }

  cxCur = detailOpen ? (cssW - DETAIL_W) / 2 : cssW / 2
  loop()

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------
  function dispose() {
    disposed = true
    running = false
    cancelAnimationFrame(raf)
    canvas.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('webglcontextlost', onContextLost)
    canvas.removeEventListener('webglcontextrestored', onContextRestored)
    window.removeEventListener('resize', doResize)
    ro.disconnect()
    pointGeo.dispose(); faintGeo.dispose(); strongGeo.dispose(); highlightGeo.dispose()
    pointMat.dispose(); faintMat.dispose(); strongMat.dispose(); highlightMat.dispose(); ringMat.dispose()
    disc.dispose(); ringTex.dispose()
    bloom.dispose(); composer.dispose(); renderer.dispose()
  }

  return {
    setData,
    setColorMode,
    setVisibleKeys,
    setControls,
    flyTo,
    onHover: (cb) => { onHoverCb = cb },
    onSelect: (cb) => { onSelectCb = cb },
    select,
    setDetailOpen: (open) => { detailOpen = open; mark() },
    highlight,
    dispose,
  }
}
