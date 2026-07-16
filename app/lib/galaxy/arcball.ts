export interface Quat { x: number; y: number; z: number; w: number }
export interface Vec3 { x: number; y: number; z: number }

export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
export const qAxis = (x: number, y: number, z: number, ang: number): Quat => {
  const h = ang / 2, s = Math.sin(h)
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(h) }
}
export const qNorm = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}
export const qConj = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
export const vRot = (v: Vec3, q: Quat): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}
export const qFromTo = (v0: Vec3, v1: Vec3): Quat => {
  const d = v0.x * v1.x + v0.y * v1.y + v0.z * v1.z
  return qNorm({ x: v0.y * v1.z - v0.z * v1.y, y: v0.z * v1.x - v0.x * v1.z, z: v0.x * v1.y - v0.y * v1.x, w: 1 + d })
}
export const angleOf = (q: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(q.w)))
export const decayQ = (qd: Quat, f: number): Quat => {
  const ang = angleOf(qd)
  if (ang < 1e-5) return { x: 0, y: 0, z: 0, w: 1 }
  const s = Math.sin(ang / 2) || 1e-6
  return qAxis(qd.x / s, qd.y / s, qd.z / s, ang * f)
}
/** Map a screen point to a point on the virtual arcball sphere (Shoemake). */
export const mapSphere = (mx: number, my: number, cx: number, cy: number, R: number): Vec3 => {
  let x = (mx - cx) / R, y = -(my - cy) / R
  const d2 = x * x + y * y
  if (d2 <= 1) return { x, y, z: Math.sqrt(1 - d2) }
  const l = Math.sqrt(d2)
  return { x: x / l, y: y / l, z: 0 }
}
