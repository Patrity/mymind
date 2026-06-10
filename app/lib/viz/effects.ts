// app/lib/viz/effects.ts
import * as THREE from 'three'
import type { Directives } from './types'

const PULSES = 3
const MAX_SPARKS = 160
const SPARK_LIFE = 0.8
const RING_RADIUS = 2.5

export function createEffects() {
  const group = new THREE.Group()

  // tool pulse rings, radiating outward while a tool runs
  const pulseGeo = new THREE.RingGeometry(0.98, 1.0, 64)
  const pulseMats: THREE.MeshBasicMaterial[] = []
  const pulseMeshes: THREE.Mesh[] = []
  for (let i = 0; i < PULSES; i++) {
    const m = new THREE.MeshBasicMaterial({
      color: 0xf59e0b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    })
    const mesh = new THREE.Mesh(pulseGeo, m)
    mesh.rotation.x = -Math.PI / 2
    group.add(mesh)
    pulseMats.push(m)
    pulseMeshes.push(mesh)
  }
  let pulsePhase = 0

  // transcription sparks: pooled points streaming from the ring into the core
  const sparkGeo = new THREE.BufferGeometry()
  const sparkPos = new Float32Array(MAX_SPARKS * 3)
  sparkPos.fill(9999) // park everything offscreen until spawned
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3))
  const sparkMat = new THREE.PointsMaterial({
    color: 0x67e8f9, size: 0.06, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const sparks = new THREE.Points(sparkGeo, sparkMat)
  sparks.frustumCulled = false
  group.add(sparks)
  const life = new Float32Array(MAX_SPARKS) // <= 0 means free slot
  const vel = new Float32Array(MAX_SPARKS * 3)

  function spawnSpark() {
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (life[i]! > 0) continue
      const th = Math.random() * Math.PI * 2
      const x = Math.cos(th) * RING_RADIUS
      const z = Math.sin(th) * RING_RADIUS
      sparkPos[i * 3] = x
      sparkPos[i * 3 + 1] = (Math.random() - 0.5) * 0.2
      sparkPos[i * 3 + 2] = z
      // head inward toward the core over one lifetime, with jitter
      vel[i * 3] = (-x / SPARK_LIFE) * (0.9 + Math.random() * 0.3)
      vel[i * 3 + 1] = (Math.random() - 0.5) * 0.4
      vel[i * 3 + 2] = (-z / SPARK_LIFE) * (0.9 + Math.random() * 0.3)
      life[i] = SPARK_LIFE
      return
    }
  }

  return {
    object: group,
    update(d: Directives, _t: number, dt: number) {
      if (d.pulseRate > 0) pulsePhase = (pulsePhase + dt * d.pulseRate) % 1
      for (let i = 0; i < PULSES; i++) {
        const ph = (pulsePhase + i / PULSES) % 1
        pulseMeshes[i]!.scale.setScalar(1 + ph * 2.6)
        pulseMats[i]!.opacity = d.pulseRate > 0 ? (1 - ph) * 0.4 : pulseMats[i]!.opacity * Math.exp(-6 * dt)
      }

      for (let n = 0; n < d.sparks; n++) spawnSpark()
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (life[i]! <= 0) continue
        life[i] = life[i]! - dt
        if (life[i]! <= 0) { sparkPos[i * 3 + 1] = 9999; continue } // park
        sparkPos[i * 3] = sparkPos[i * 3]! + vel[i * 3]! * dt
        sparkPos[i * 3 + 1] = sparkPos[i * 3 + 1]! + vel[i * 3 + 1]! * dt
        sparkPos[i * 3 + 2] = sparkPos[i * 3 + 2]! + vel[i * 3 + 2]! * dt
      }
      sparkGeo.attributes.position!.needsUpdate = true
    },
    dispose() {
      pulseGeo.dispose()
      pulseMats.forEach(m => m.dispose())
      sparkGeo.dispose()
      sparkMat.dispose()
    },
  }
}
