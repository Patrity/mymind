// app/lib/viz/core.ts
import * as THREE from 'three'
import type { Directives } from './types'
import type { Pose } from '../avatar/types'
import { VIZ_TUNING, PALETTE } from './tuning'

/** Point cloud baked from a head mesh, already split out of the 9-float stride.
 *  Supplying it swaps the procedural sphere for the head and enables the pose path. */
export interface CoreHead {
  count: number
  position: Float32Array // 3 per point
  normal: Float32Array // 3 per point, unit length
  jaw: Float32Array // 1 per point
  eye: Float32Array
  brow: Float32Array
}

/** GLSL float literal — `1` is an int in GLSL and would fail to compile in a float slot. */
const f = (n: number) => n.toFixed(5)

function vertexShader(head: boolean): string {
  const H = VIZ_TUNING.head
  return /* glsl */ `
uniform float uTime;
uniform float uEnergy;
uniform float uSwirl;
uniform float uShatter;
uniform float uAssemble;
uniform float uIgnite;
uniform float uDim;
uniform float uSize;
uniform float uAlpha;
attribute vec3 aScatter;
attribute vec4 aSeed;
varying float vAlpha;
${head
  ? /* glsl */ `
uniform float uJaw;
uniform float uBrow;
uniform float uYaw;
uniform float uPitch;
uniform float uScan;
uniform float uEyeGain;
attribute vec3 aNormal;
attribute float aJawW;
attribute float aEyeW;
attribute float aBrowW;
varying float vScan;

const float JAW_TRAVEL = ${f(H.jawTravel)};
const float BROW_LIFT  = ${f(H.browLift)};
const float PIVOT_Y    = ${f(H.pivotY)};
const float PIVOT_Z    = ${f(H.pivotZ)};
const float FACING_FLOOR = ${f(H.facingFloor)};
const float SCAN_MIN_Y = ${f(H.scanMinY)};
const float SCAN_MAX_Y = ${f(H.scanMaxY)};
const float SCAN_WIDTH = ${f(H.scanWidth)};
`
  : ''}

void main() {
  vec3 p = position;
${head
  ? /* glsl */ `
  vec3 n = aNormal;

  // Jaw: displace DOWN in head-local space, weighted by the baked ramp. A binary jaw
  // region translated as a block visibly CLEAVES THE HEAD at the lip line — aJawW is a
  // smooth 0-at-the-lip to 1-at-the-chin ramp for exactly that reason.
  p.y -= uJaw * JAW_TRAVEL * aJawW;
  p.y += uBrow * BROW_LIFT * aBrowW;

  // Yaw about the vertical axis. Positive = turned toward the viewer's right.
  float cy = cos(uYaw), sy = sin(uYaw);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  n = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);

  // Pitch about a pivot BEHIND and BELOW the face, near the base of the skull.
  // Rotating about the mesh origin translates the face up the screen instead of
  // rotating it, which reads as a slide rather than a look.
  //
  // POSITIVE uPitch = LOOKING UP. The face is on +Z, and a textbook positive rotation
  // about +X carries +Z toward -Y (chin up, nose DOWN) — hence the flipped sign below.
  // Getting this backwards is what made "thinking" stare at the floor; choreography.ts
  // emits positive pitch for thinking and negative for a nod, and is tested on it.
  vec3 pivot = vec3(0.0, PIVOT_Y, PIVOT_Z);
  vec3 q = p - pivot;
  float cp = cos(uPitch), sp = sin(uPitch);
  q = vec3(q.x, q.y * cp + q.z * sp, -q.y * sp + q.z * cp);
  p = q + pivot;
  n = vec3(n.x, n.y * cp + n.z * sp, -n.y * sp + n.z * cp);

  // A head must not inflate on volume — that reads as a balloon. Jitter each point
  // along its own normal instead, plus a shallow breath.
  p *= 1.0 + 0.012 * sin(uTime * 1.1 + aSeed.x * 6.2831);
  p += n * (uEnergy * 0.03 + uIgnite * 0.10) * (0.25 + aSeed.y);
`
  : /* glsl */ `
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
`}

  // barge-in shatter: fly out toward the per-particle scatter point
  p = mix(p, aScatter * (1.2 + aSeed.z), uShatter);
  // connect assembly: from the scatter cloud into place
  p = mix(aScatter, p, uAssemble);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (0.6 + aSeed.w) * (1.0 + uEnergy * 0.7) * (220.0 / -mv.z);
  // disconnected: slow, irregular per-particle flicker (uDim≈1); negligible at idle dim
  float flick = 1.0 - uDim * uDim * 0.35 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed.x * 0.9) + aSeed.y * 6.2831));
  vAlpha = uAlpha * (1.0 - uDim * 0.75) * (0.3 + 0.7 * aSeed.w) * flick;
${head
  ? /* glsl */ `
  // Facing: dim the far side of the skull so the cloud reads as a head instead of a blob.
  vec3 nv = normalize(normalMatrix * n);
  vAlpha *= mix(FACING_FLOOR, 1.0, smoothstep(-0.45, 0.35, nv.z));
  // Eye region brightens on attention (listening/thinking).
  vAlpha *= 1.0 + (uEyeGain - 1.0) * aEyeW;

  // Amber tool scan: a band sweeping up the face. Banded on the UNPOSED y so it stays
  // locked to the anatomy while the head moves. uScan runs past 1.0 into a gap between
  // sweeps, and rests at 0 — gate both ends so a resting scan is not a band on the chin.
  float scanGate = smoothstep(0.0, 0.05, uScan) * (1.0 - smoothstep(1.0, 1.08, uScan));
  float scanY = mix(SCAN_MIN_Y, SCAN_MAX_Y, uScan);
  vScan = scanGate * (1.0 - smoothstep(0.0, SCAN_WIDTH, abs(position.y - scanY)));
  vAlpha *= 1.0 + vScan * 1.2;
  gl_PointSize *= 1.0 + vScan * 0.6;
`
  : ''}
}
`
}

function fragmentShader(head: boolean): string {
  return /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uErrorFlash;
varying float vAlpha;
${head ? 'uniform vec3 uScanColor;\nvarying float vScan;' : ''}

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float glow = smoothstep(0.25, 0.0, r2);
  vec3 col = uColor;
${head ? '  col = mix(col, uScanColor, clamp(vScan, 0.0, 1.0) * 0.85);' : ''}
  col = mix(col, vec3(1.0, 0.3, 0.3), uErrorFlash * 0.8);
  gl_FragColor = vec4(col, glow * vAlpha);
}
`
}

/**
 * The particle cloud. With no `head` it is the original procedural sphere; with a
 * baked head it binds the extra per-point attributes and the pose uniforms.
 *
 * `particles` is only the initial draw budget — when a head is supplied the geometry
 * always holds every baked point and the quality tier is applied through
 * `setDrawRange`, so one 50k bake serves the 25k and 10k tiers too.
 */
export function createCore(particles: number, head?: CoreHead) {
  const total = head ? head.count : particles
  const geo = new THREE.BufferGeometry()
  const scatter = new Float32Array(total * 3)
  const seed = new Float32Array(total * 4)

  let pos: Float32Array
  if (head) {
    pos = head.position
    geo.setAttribute('aNormal', new THREE.BufferAttribute(head.normal, 3))
    geo.setAttribute('aJawW', new THREE.BufferAttribute(head.jaw, 1))
    geo.setAttribute('aEyeW', new THREE.BufferAttribute(head.eye, 1))
    geo.setAttribute('aBrowW', new THREE.BufferAttribute(head.brow, 1))
  } else {
    pos = new Float32Array(total * 3)
  }

  for (let i = 0; i < total; i++) {
    if (!head) {
      // uniform point on a slightly fuzzed unit sphere
      const u = Math.random() * 2 - 1
      const th = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const r = 1.0 + Math.random() * 0.15
      pos[i * 3] = s * Math.cos(th) * r
      pos[i * 3 + 1] = u * r
      pos[i * 3 + 2] = s * Math.sin(th) * r
    }
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
  // A posed head leaves its baked bounding sphere; without this the whole cloud can
  // be culled the moment the jaw or a saccade pushes a point outside it.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8)

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 }, uEnergy: { value: 0 }, uSwirl: { value: 0 },
    uShatter: { value: 0 }, uAssemble: { value: 0 }, uIgnite: { value: 0 },
    uDim: { value: 0 },
    // gl_PointSize ≈ uSize * (220 / cameraZ) device px — see VIZ_TUNING.core.
    uSize: { value: head ? VIZ_TUNING.head.pointSize : VIZ_TUNING.core.pointSize },
    uAlpha: { value: head ? VIZ_TUNING.head.alpha : VIZ_TUNING.core.alpha },
    uColor: { value: new THREE.Color() }, uErrorFlash: { value: 0 }
  }
  if (head) {
    uniforms.uJaw = { value: 0 }
    uniforms.uBrow = { value: 0 }
    uniforms.uYaw = { value: 0 }
    uniforms.uPitch = { value: 0 }
    uniforms.uScan = { value: 0 }
    uniforms.uEyeGain = { value: 1 }
    uniforms.uScanColor = { value: new THREE.Color(...PALETTE.tool.core) }
  }

  const mat = new THREE.ShaderMaterial({
    vertexShader: vertexShader(!!head),
    fragmentShader: fragmentShader(!!head),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms
  })
  const points = new THREE.Points(geo, mat)
  if (head) points.scale.setScalar(VIZ_TUNING.head.scale)
  else points.rotation.x = 0.15

  return {
    object: points,
    /** `pose` is required for a head core and ignored by the sphere. */
    update(d: Directives, t: number, dt: number, pose?: Pose) {
      const u = mat.uniforms
      u.uTime!.value = t
      u.uEnergy!.value = d.energy
      u.uSwirl!.value = d.swirl
      u.uShatter!.value = d.shatter
      u.uIgnite!.value = d.ignite
      u.uDim!.value = d.dim
      u.uErrorFlash!.value = d.errorFlash
      ;(u.uColor!.value as THREE.Color).setRGB(d.coreColor[0]!, d.coreColor[1]!, d.coreColor[2]!)
      if (head && pose) {
        u.uJaw!.value = pose.jaw
        u.uBrow!.value = pose.brow
        u.uYaw!.value = pose.yaw
        u.uPitch!.value = pose.pitch
        u.uScan!.value = pose.scan
        u.uEyeGain!.value = pose.eyeGain
        // A head that half-dissolves reads as "she's gone"; the sphere's disconnected
        // sag (Directives.assemble -> 0.5) is the same idea, so take the lower of the two.
        u.uAssemble!.value = Math.min(pose.assemble, d.assemble)
      } else {
        u.uAssemble!.value = d.assemble
        // The sphere has no front, so it spins; a head must not.
        points.rotation.y += (0.0015 + d.energy * 0.004 + d.swirl * 0.01) * dt * 60
      }
    },
    /** One-way perf step: draw only the first `frac` of the points. The bake samples
     *  the surface in random order, so a prefix is still an even covering. */
    setDrawRange(frac: number) { geo.setDrawRange(0, Math.floor(total * frac)) },
    dispose() { geo.dispose(); mat.dispose() }
  }
}
