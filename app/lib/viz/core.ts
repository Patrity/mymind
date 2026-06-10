// app/lib/viz/core.ts
import * as THREE from 'three'
import type { Directives } from './types'

const VERT = /* glsl */ `
uniform float uTime;
uniform float uEnergy;
uniform float uSwirl;
uniform float uShatter;
uniform float uAssemble;
uniform float uIgnite;
uniform float uDim;
uniform float uSize;
attribute vec3 aScatter;
attribute vec4 aSeed;
varying float vAlpha;

void main() {
  vec3 p = position;

  // thinking vortex: flatten toward a disc and swirl per-particle
  float flatten = uSwirl * 0.75;
  p.y *= (1.0 - flatten);
  float ang = uSwirl * (2.0 + aSeed.x * 4.0) + uTime * uSwirl * (0.6 + aSeed.y);
  float ca = cos(ang); float sa = sin(ang);
  p = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca);

  // breathing + voice burst + connect ignition
  float breathe = 1.0 + 0.05 * sin(uTime * 1.4 + aSeed.x * 6.2831);
  float burst = 1.0 + uEnergy * (0.25 + aSeed.y * 0.9) + uIgnite * aSeed.z * 0.9;
  p *= breathe * burst;

  // barge-in shatter: fly out toward the per-particle scatter point
  p = mix(p, aScatter * (1.2 + aSeed.z), uShatter);
  // connect assembly: from the scatter cloud into place
  p = mix(aScatter, p, uAssemble);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aSeed.w) * (1.0 + uEnergy * 0.7) * (220.0 / -mv.z);
  // disconnected: slow, irregular per-particle flicker (uDim≈1); negligible at idle dim
  float flick = 1.0 - uDim * uDim * 0.35 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed.x * 0.9) + aSeed.y * 6.2831));
  vAlpha = (1.0 - uDim * 0.75) * (0.3 + 0.7 * aSeed.w) * flick;
}
`

const FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uErrorFlash;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float glow = smoothstep(0.25, 0.0, r2);
  vec3 col = mix(uColor, vec3(1.0, 0.3, 0.3), uErrorFlash * 0.8);
  gl_FragColor = vec4(col, glow * vAlpha);
}
`

export function createCore(particles: number) {
  const geo = new THREE.BufferGeometry()
  const pos = new Float32Array(particles * 3)
  const scatter = new Float32Array(particles * 3)
  const seed = new Float32Array(particles * 4)
  for (let i = 0; i < particles; i++) {
    // uniform point on a slightly fuzzed unit sphere
    const u = Math.random() * 2 - 1
    const th = Math.random() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const r = 1.0 + Math.random() * 0.15
    pos[i * 3] = s * Math.cos(th) * r
    pos[i * 3 + 1] = u * r
    pos[i * 3 + 2] = s * Math.sin(th) * r
    // scatter target: random direction, 3–6 units out
    const su = Math.random() * 2 - 1
    const sth = Math.random() * Math.PI * 2
    const ss = Math.sqrt(1 - su * su)
    const sr = 3 + Math.random() * 3
    scatter[i * 3] = ss * Math.cos(sth) * sr
    scatter[i * 3 + 1] = su * sr
    scatter[i * 3 + 2] = ss * Math.sin(sth) * sr
    seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random()
    seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random()
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3))
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4))

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uEnergy: { value: 0 }, uSwirl: { value: 0 },
      uShatter: { value: 0 }, uAssemble: { value: 0 }, uIgnite: { value: 0 },
      uDim: { value: 0 },
      // uSize is in device px at ~1 world unit from camera scale: with the camera at
      // z≈6.2, gl_PointSize ≈ uSize * 35 → ~3-5px points. (220/-mv.z ≈ 35 here.)
      uSize: { value: 0.1 },
      uColor: { value: new THREE.Color() }, uErrorFlash: { value: 0 },
    },
  })
  const points = new THREE.Points(geo, mat)
  points.rotation.x = 0.15

  return {
    object: points,
    update(d: Directives, t: number, dt: number) {
      const u = mat.uniforms
      u.uTime!.value = t
      u.uEnergy!.value = d.energy
      u.uSwirl!.value = d.swirl
      u.uShatter!.value = d.shatter
      u.uAssemble!.value = d.assemble
      u.uIgnite!.value = d.ignite
      u.uDim!.value = d.dim
      u.uErrorFlash!.value = d.errorFlash
      ;(u.uColor!.value as THREE.Color).setRGB(d.coreColor[0]!, d.coreColor[1]!, d.coreColor[2]!)
      points.rotation.y += (0.0015 + d.energy * 0.004 + d.swirl * 0.01) * dt * 60
    },
    /** One-way perf step: draw only the first `frac` of the particles. */
    setDrawRange(frac: number) { geo.setDrawRange(0, Math.floor(particles * frac)) },
    dispose() { geo.dispose(); mat.dispose() },
  }
}
