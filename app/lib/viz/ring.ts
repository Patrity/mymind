// app/lib/viz/ring.ts
import * as THREE from 'three'
import { BAR_COUNT } from './types'
import type { Directives } from './types'

const RADIUS = 2.5
const ERROR_RED = new THREE.Color(1, 0.25, 0.25)

export function createRing() {
  const geo = new THREE.BoxGeometry(0.035, 1, 0.035)
  geo.translate(0, 0.5, 0) // grow upward from the base when y-scaled
  const mat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, BAR_COUNT)
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BAR_COUNT * 3), 3)
  const dummy = new THREE.Object3D()
  const color = new THREE.Color()

  return {
    object: mesh,
    update(d: Directives, t: number, dt: number) {
      for (let i = 0; i < BAR_COUNT; i++) {
        const th = (i / BAR_COUNT) * Math.PI * 2
        const ambient = 0.05 + 0.03 * Math.sin(i * 0.7 + t * 1.5)
        const mic = (d.ringLevels[i] ?? 0) * 1.1 * d.micMix
        const ripple = d.outLevel * 0.18 * Math.abs(Math.sin(i * 0.5 + t * 2.0))
        const h = Math.max(0.04, ambient + mic + ripple) * (1 - d.dim * 0.8)
        dummy.position.set(Math.cos(th) * RADIUS, 0, Math.sin(th) * RADIUS)
        dummy.rotation.set(0, -th, 0)
        dummy.scale.set(1, h, 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)

        // error shockwave: a red front sweeps once around as the flash decays
        color.setRGB(d.ringColor[0]!, d.ringColor[1]!, d.ringColor[2]!)
        if (d.errorFlash > 0.01) {
          const front = (1 - d.errorFlash) * Math.PI * 2
          const dist = Math.abs(((th - front + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
          color.lerp(ERROR_RED, Math.max(0, 1 - dist / 0.6) * d.errorFlash)
        }
        mesh.setColorAt(i, color)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.rotation.y += (0.0006 + d.micMix * 0.002) * dt * 60
    },
    dispose() { geo.dispose(); mat.dispose(); mesh.dispose() },
  }
}
