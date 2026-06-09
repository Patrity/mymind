<!-- app/components/voice/Reactor.client.vue -->
<script setup lang="ts">
import * as THREE from 'three'
import type { VoiceState } from '~/composables/useUnmute'

const props = defineProps<{
  state: VoiceState
  analyser: () => AnalyserNode | null
}>()

const host = ref<HTMLDivElement | null>(null)
let raf = 0
let renderer: THREE.WebGLRenderer | null = null

// palette per state (kept here, not in CSS, since it's a GL material colour)
const PALETTE: Record<VoiceState, number> = {
  idle: 0x3b82f6, listening: 0x06b6d4, thinking: 0xf59e0b, speaking: 0x22d3ee
}

onMounted(() => {
  const el = host.value!
  const w = el.clientWidth, h = el.clientHeight
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 100)
  camera.position.z = 5
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  el.appendChild(renderer.domElement)

  // core
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 2),
    new THREE.MeshStandardMaterial({ color: PALETTE.idle, emissive: PALETTE.idle, emissiveIntensity: 0.6, wireframe: true })
  )
  scene.add(core)

  // orbiting node ring
  const NODES = 48
  const ringGeo = new THREE.BufferGeometry()
  const positions = new Float32Array(NODES * 3)
  for (let i = 0; i < NODES; i++) {
    const a = (i / NODES) * Math.PI * 2
    positions[i * 3] = Math.cos(a) * 2.2
    positions[i * 3 + 1] = Math.sin(a) * 2.2
    positions[i * 3 + 2] = 0
  }
  ringGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const ring = new THREE.Points(ringGeo, new THREE.PointsMaterial({ color: PALETTE.idle, size: 0.08 }))
  scene.add(ring)

  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  const pl = new THREE.PointLight(0xffffff, 1.2)
  pl.position.set(3, 3, 5)
  scene.add(pl)

  const data = new Uint8Array(128)
  function amplitude(): number {
    const an = props.analyser()
    if (!an) return 0
    an.getByteFrequencyData(data as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] ?? 0
    return sum / data.length / 255 // 0..1
  }

  function frame() {
    raf = requestAnimationFrame(frame)
    const amp = amplitude()
    const color = new THREE.Color(PALETTE[props.state])
    ;(core.material as THREE.MeshStandardMaterial).color.lerp(color, 0.1)
    ;(core.material as THREE.MeshStandardMaterial).emissive.lerp(color, 0.1)
    ;(ring.material as THREE.PointsMaterial).color.lerp(color, 0.1)
    const scale = 1 + amp * 0.6
    core.scale.setScalar(scale)
    core.rotation.y += 0.004 + amp * 0.05
    core.rotation.x += 0.002
    ring.rotation.z += 0.003 + amp * 0.04
    renderer!.render(scene, camera)
  }
  frame()

  const onResize = () => {
    const nw = el.clientWidth
    const nh = el.clientHeight
    camera.aspect = nw / nh
    camera.updateProjectionMatrix()
    renderer!.setSize(nw, nh)
  }
  window.addEventListener('resize', onResize)
  onUnmounted(() => {
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    core.geometry.dispose()
    ;(core.material as THREE.MeshStandardMaterial).dispose()
    ringGeo.dispose()
    ;(ring.material as THREE.PointsMaterial).dispose()
    renderer?.dispose()
    el.innerHTML = ''
  })
})
</script>

<template>
  <div
    ref="host"
    class="size-full min-h-[320px]"
  />
</template>
