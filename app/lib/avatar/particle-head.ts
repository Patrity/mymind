// app/lib/avatar/particle-head.ts
// The ParticleHead renderer: the same GPU machinery the sphere reactor used
// (scene.ts renderer + EffectComposer + UnrealBloomPass + quality tiers + degrade(),
// effects.ts tool pulses and sparks, lightning.ts synapse bolts) re-pointed at a head
// point distribution baked by scripts/bake-head.ts.
//
// It owns the render loop because the Avatar interface is push-only: state and
// analysers go in, pixels come out, and nothing in here touches the WebSocket.
import { createScene, detectTier } from '../viz/scene'
import { createCore } from '../viz/core'
import { createEffects } from '../viz/effects'
import { createLightning } from '../viz/lightning'
import { createChoreographer as createVizChoreographer } from '../viz/choreographer'
import { createChoreographer as createPoseChoreographer } from './choreography'
import { BAR_COUNT } from '../viz/types'
import { VIZ_TUNING } from '../viz/tuning'
import type { VizState } from '../viz/types'
import type { Avatar } from './types'
import { parseHeadBuffer, HeadBufferError, type HeadPoints } from './head-buffer'

export interface ParticleHeadOptions {
  /**
   * Called when the renderer gives up after it was already running (repeated frame
   * faults). The mount point should swap to its non-WebGL fallback. Failures during
   * `createParticleHead` itself reject the promise instead.
   */
  onFatal?: (err: unknown) => void
  /** Seeded RNG for the pose choreographer; defaults to Math.random. */
  rng?: () => number
}

// Resolved by Vite at build time. The mesh is a human export step that may not have
// happened yet, so the file is legitimately absent — a glob that matches nothing is an
// empty record, which is exactly the "no head available" signal we want rather than a
// build error on a missing import.
const HEAD_BIN = import.meta.glob('../../assets/head-points.bin', {
  query: '?url',
  import: 'default'
}) as Record<string, () => Promise<string>>

/**
 * Fetch and parse the baked point buffer.
 *
 * Every "no usable buffer" outcome — not baked yet, 404, network failure, truncated
 * download, an HTML SPA response served in place of the asset — surfaces as a
 * HeadBufferError so the caller can drop to the CSS fallback instead of throwing.
 */
export async function loadHeadPoints(): Promise<HeadPoints> {
  const loader = Object.values(HEAD_BIN)[0]
  if (!loader) {
    throw new HeadBufferError(
      'app/assets/head-points.bin is not present — export the head mesh and run `pnpm bake:head`'
    )
  }
  let url: string
  try {
    url = await loader()
  } catch (err) {
    throw new HeadBufferError(`head buffer module failed to resolve: ${String(err)}`)
  }
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    throw new HeadBufferError(`head buffer fetch failed: ${String(err)}`)
  }
  if (!res.ok) throw new HeadBufferError(`head buffer fetch failed: HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  return parseHeadBuffer(bytes)
}

/**
 * Build the head renderer inside `host`. Deviation from the brief's signature: it takes
 * the CONTAINER, not a canvas — scene.ts creates and owns the canvas (and must, so the
 * context-loss rebuild can replace it), so handing it one would leave it orphaned.
 *
 * Rejects (never throws synchronously) when there is no usable head buffer or WebGL
 * refuses to initialise; the caller shows its fallback.
 */
export async function createParticleHead(
  host: HTMLElement,
  opts: ParticleHeadOptions = {}
): Promise<Avatar> {
  const points = await loadHeadPoints()

  // State that must survive a context-loss rebuild.
  let vizState: VizState = 'connecting'
  let mic: AnalyserNode | null = null
  let out: AnalyserNode | null = null
  let disposed = false

  const vizChoreo = createVizChoreographer()
  const poseChoreo = createPoseChoreographer(opts.rng)

  let teardown: (() => void) | null = null
  // Reassigned on every (re)boot — a context-loss rebuild makes a whole new scene, so
  // resize() must not close over the dead one.
  let setSize: (w: number, h: number) => void = () => {}

  function boot() {
    let scene: ReturnType<typeof createScene> | undefined
    let core: ReturnType<typeof createCore> | undefined
    let fx: ReturnType<typeof createEffects> | undefined
    let bolts: ReturnType<typeof createLightning> | undefined
    const tier = detectTier()
    try {
      scene = createScene(host, tier)
      core = createCore(tier.particles, points)
      fx = createEffects()
      bolts = createLightning()
      // lightning arcs are generated on a unit shell — match the head's scale so they
      // stay inside the skull rather than firing around a head-sized cloud.
      bolts.object.scale.setScalar(VIZ_TUNING.head.scale)
      scene.scene.add(core.object, fx.object, bolts.object)
    } catch (err) {
      bolts?.dispose()
      fx?.dispose()
      core?.dispose()
      scene?.dispose()
      throw err
    }

    // One 50k bake serves every tier: draw a prefix rather than baking three files.
    const baseFrac = Math.min(1, tier.particles / points.count)
    core.setDrawRange(baseFrac)

    const micData = new Uint8Array(128) // analyser fftSize 256 → 128 bins
    const outData = new Uint8Array(128)
    const micLevels = new Float32Array(BAR_COUNT)

    // FPS watchdog: sustained sub-27fps average triggers two one-way degrade steps.
    // (Threshold sits below 30 so healthy 30Hz displays never trip it.)
    let degradeStep = 0
    let dtAvg = 1 / 60
    let slowSince = 0
    let frameErrors = 0

    let raf = 0
    let last = performance.now()
    let t = 0

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      t += dt

      try {
        if (mic) {
          mic.getByteFrequencyData(micData as Uint8Array<ArrayBuffer>)
          for (let i = 0; i < BAR_COUNT; i++) {
            micLevels[i] = (micData[Math.floor(i * micData.length / BAR_COUNT)] ?? 0) / 255
          }
        } else {
          micLevels.fill(0)
        }
        let outLevel = 0
        if (out) {
          out.getByteFrequencyData(outData as Uint8Array<ArrayBuffer>)
          let sum = 0
          for (let i = 0; i < outData.length; i++) sum += outData[i] ?? 0
          outLevel = sum / outData.length / 255
        }

        // The viz choreographer owns colour/energy/effects and re-derives the
        // disconnected state from `connected`; the pose choreographer takes that
        // derived state so 'disconnected' reaches the face too.
        const d = vizChoreo.update({
          state: vizState === 'disconnected' ? 'idle' : vizState,
          connected: vizState !== 'disconnected',
          micLevels,
          outLevel
        }, dt)
        const pose = poseChoreo.step(d.vizState, dt, d.outLevel)

        core!.update(d, t, dt, pose)
        fx!.update(d, t, dt)
        // bolts fire inside the skull — follow the head's pose so they stay in it.
        // Negated pitch: Three's rotation about +X is the textbook one, which the head
        // shader deliberately inverts so positive pitch means looking UP.
        bolts!.object.rotation.set(-pose.pitch, pose.yaw, 0)
        bolts!.update(d, t, dt)
        scene!.render()

        dtAvg += (dt - dtAvg) * 0.05 // ~smooth over the last couple seconds of frames
        if (dtAvg > 1 / 27) { if (!slowSince) slowSince = now } else slowSince = 0
        if (slowSince && now - slowSince > 3000 && degradeStep < 2) {
          degradeStep++
          if (degradeStep === 1) scene!.degrade()
          else core!.setDrawRange(baseFrac * 0.5)
          slowSince = 0
          dtAvg = 1 / 60 // re-measure from a clean slate after each step
        }

        frameErrors = 0
      } catch (err) {
        // A persistent render fault should degrade to the fallback, not spam forever.
        if (++frameErrors >= 10) {
          console.error('[avatar] persistent frame failure — falling back', err)
          teardown?.()
          opts.onFatal?.(err)
        }
      }
    }
    raf = requestAnimationFrame(frame)

    const onVis = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden && !disposed) {
        last = performance.now()
        raf = requestAnimationFrame(frame)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    // Scroll-zoom: dolly the camera instead of scrolling the page.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      scene!.zoom(e.deltaY)
    }
    host.addEventListener('wheel', onWheel, { passive: false })

    scene.onContextLost(() => {
      // GPU reset (driver hiccup, mobile background) — rebuild the whole scene. The
      // parsed point buffer is kept in memory, so this costs no second download.
      teardown?.()
      if (disposed) return
      try {
        boot()
      } catch (err) {
        console.error('[avatar] rebuild after context loss failed', err)
        opts.onFatal?.(err)
      }
    })

    teardown = () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      host.removeEventListener('wheel', onWheel)
      bolts!.dispose()
      core!.dispose()
      fx!.dispose()
      scene!.dispose()
      teardown = null
    }

    setSize = scene.setSize
  }

  boot()

  const avatar: Avatar = {
    setState(s) { vizState = s },
    pushEvent(e) { vizChoreo.handleEvent(e) },
    setAnalysers(m, o) { mic = m; out = o },
    resize(w, h) { setSize(w || 320, h || 320) },
    dispose() {
      disposed = true
      teardown?.()
    }
  }
  return avatar
}
