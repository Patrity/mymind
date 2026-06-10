// app/lib/viz/scene.ts
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'

export interface QualityTier { particles: number; pixelRatioCap: number; bloomScale: number }

export function detectTier(): QualityTier {
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  const cores = navigator.hardwareConcurrency ?? 4
  if (mobile) return { particles: 10_000, pixelRatioCap: 1.5, bloomScale: 0.5 }
  if (cores <= 4) return { particles: 25_000, pixelRatioCap: 2, bloomScale: 0.75 }
  return { particles: 50_000, pixelRatioCap: 2, bloomScale: 1 }
}

export interface VizScene {
  scene: THREE.Scene
  render: () => void
  setSize: (w: number, h: number) => void
  /** One-way quality step: drops render resolution 25%. */
  degrade: () => void
  onContextLost: (cb: () => void) => void
  dispose: () => void
}

export function createScene(el: HTMLElement, tier: QualityTier): VizScene {
  // The flex cell may not have laid out on the first frame — avoid NaN aspect.
  const w = el.clientWidth || 320
  const h = el.clientHeight || 320
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100)
  camera.position.set(0, 0.6, 6.2)
  camera.lookAt(0, 0, 0)

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' })
  let ratio = Math.min(devicePixelRatio, tier.pixelRatioCap)
  renderer.setPixelRatio(ratio)
  renderer.setSize(w, h)
  el.appendChild(renderer.domElement)

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(ratio)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w * tier.bloomScale, h * tier.bloomScale),
    1.1,  // strength
    0.55, // radius
    0.12  // threshold — particles are dim-ish; let most of them bloom
  )
  composer.addPass(bloom)

  let lostCb: (() => void) | null = null
  const onLost = (e: Event) => { e.preventDefault(); lostCb?.() }
  renderer.domElement.addEventListener('webglcontextlost', onLost)

  return {
    scene,
    render: () => composer.render(),
    setSize: (nw, nh) => {
      camera.aspect = nw / nh
      camera.updateProjectionMatrix()
      renderer.setSize(nw, nh)
      composer.setSize(nw, nh)
    },
    degrade: () => {
      ratio = Math.max(0.75, ratio * 0.75)
      renderer.setPixelRatio(ratio)
      composer.setPixelRatio(ratio)
      composer.setSize(el.clientWidth || w, el.clientHeight || h)
    },
    onContextLost: (cb) => { lostCb = cb },
    dispose: () => {
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      composer.dispose()
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    },
  }
}
