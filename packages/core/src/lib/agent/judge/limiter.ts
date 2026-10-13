// Cycle 84 final fix wave (I5): a per-process cap on judge + guard LLM calls. They share the inference
// server with the pooled workstream segments (cycle 83) but were unpooled: under fan-out (six research
// children, each guarding every fetch) guard calls queued behind each other and hit their 15 s deadline,
// and a fail-closed guard took workspaces offline on routine load. A FIFO semaphore caps the calls in
// flight; the rest wait their turn. A queued call's wait counts toward ITS OWN deadline — the caller
// passes the signal that carries it, and a wait that outlives it rejects exactly like a call that timed
// out (judge: error verdict → review; guard: fail closed on the run only, never on the workspace — I5).
//
// Cycle 85 final fix wave (I1): THREE separate semaphores, one per class of call, so a long call of one
// class never delays another class:
//   guard    — the output guard (15 s deadline; default 4 in flight). A starved guard fails closed and
//              taints Tony's live run, so nothing else may queue in front of it;
//   approval — the approval-card verdict (default 2);
//   outcome  — the outcome verifier on finish_workstream and the eval rubric judge (60 s; default 2).
// Settings `judge.maxInFlight` is `{ guard, approval, outcome }`; a bare number (the cycle-84 shape)
// sizes `guard` and leaves the others at their defaults. Inside an eval world a call first takes the
// eval's ONE slot of its class (EvalScope.throttle), so an eval run never holds more than one slot of
// any class.

import { currentEvalScope } from '../../eval/context'
import { DEFAULT_JUDGE_MAX_IN_FLIGHT, type JudgeClass, type JudgeMaxInFlight } from './types'

export { DEFAULT_JUDGE_MAX_IN_FLIGHT, type JudgeClass, type JudgeMaxInFlight }
export const JUDGE_CLASSES: readonly JudgeClass[] = ['guard', 'approval', 'outcome']
export const JUDGE_MAX_IN_FLIGHT_LIMITS = { min: 1, max: 16 } as const

const validCap = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= JUDGE_MAX_IN_FLIGHT_LIMITS.min && n <= JUDGE_MAX_IN_FLIGHT_LIMITS.max

/** Pure: any stored / patched value → the three caps. A number sizes `guard` (back-compat); an object
 *  is read field by field; anything invalid reads as that class's default (a capacity knob, not a
 *  safety switch). */
export function normalizeJudgeMaxInFlight(v: unknown): JudgeMaxInFlight {
  if (typeof v === 'number') return { ...DEFAULT_JUDGE_MAX_IN_FLIGHT, guard: validCap(v) ? v : DEFAULT_JUDGE_MAX_IN_FLIGHT.guard }
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  return Object.fromEntries(JUDGE_CLASSES.map(k => [k, validCap(o[k]) ? o[k] : DEFAULT_JUDGE_MAX_IN_FLIGHT[k]])) as JudgeMaxInFlight
}

interface Semaphore { max: number; active: number; queue: Array<() => void> }
const sems: Record<JudgeClass, Semaphore> = {
  guard: { max: DEFAULT_JUDGE_MAX_IN_FLIGHT.guard, active: 0, queue: [] },
  approval: { max: DEFAULT_JUDGE_MAX_IN_FLIGHT.approval, active: 0, queue: [] },
  outcome: { max: DEFAULT_JUDGE_MAX_IN_FLIGHT.outcome, active: 0, queue: [] }
}

/** Settings → judge.maxInFlight (agent-settings.ts sets it whenever it reads the settings). Raising a
 *  cap lets that class's queued calls start at once. */
export function setJudgeMaxInFlight(v: unknown): void {
  const caps = normalizeJudgeMaxInFlight(v)
  for (const k of JUDGE_CLASSES) {
    sems[k].max = caps[k]
    pump(sems[k])
  }
}

function pump(s: Semaphore): void {
  while (s.active < s.max && s.queue.length) {
    s.active++
    s.queue.shift()!()
  }
}

/** Wait for a slot (FIFO). Rejects with the signal's reason if it fires first — the waiter leaves the
 *  queue and never takes a slot. */
function acquire(s: Semaphore, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  if (s.active < s.max && !s.queue.length) { s.active++; return Promise.resolve() }
  return new Promise<void>((resolve, reject) => {
    const grant = () => { signal?.removeEventListener('abort', onAbort); resolve() }
    const onAbort = () => {
      const i = s.queue.indexOf(grant)
      if (i >= 0) s.queue.splice(i, 1)
      reject(signal!.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    s.queue.push(grant)
  })
}

function release(s: Semaphore): void {
  s.active = Math.max(0, s.active - 1)
  pump(s)
}

/** Run `fn` holding one slot of `kind`. `signal` bounds the WAIT (and is the caller's deadline).
 *  Inside an eval world the call first takes the eval's one slot of that class (EvalScope.throttle). */
export async function withJudgeSlot<T>(kind: JudgeClass, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const throttle = currentEvalScope()?.throttle
  if (throttle) {
    const evalRelease = await throttle(kind, signal)
    try { return await slotted(sems[kind], signal, fn) } finally { evalRelease() }
  }
  return slotted(sems[kind], signal, fn)
}

async function slotted<T>(s: Semaphore, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  await acquire(s, signal)
  try { return await fn() } finally { release(s) }
}

/** Tests / diagnostics. */
export function judgeSlotStats(kind: JudgeClass = 'guard'): { active: number; queued: number; max: number } {
  const s = sems[kind]
  return { active: s.active, queued: s.queue.length, max: s.max }
}
