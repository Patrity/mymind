export interface Spring { c: number; t: number; v: number }
export const makeSpring = (v: number): Spring => ({ c: v, t: v, v: 0 })
export function stepSpring(s: Spring, stiffness = 0.14, damping = 0.52): void {
  const a = (s.t - s.c) * stiffness - s.v * damping
  s.v += a
  s.c += s.v
}
