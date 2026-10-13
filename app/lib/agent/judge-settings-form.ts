// app/lib/agent/judge-settings-form.ts
// Task 4 fix round 1 (M2, M7): the Settings → Bridget judge form's logic, pure so it is unit-tested.
// The component (settings/JudgeSettings.vue) only binds these.
import type { JudgeSettings } from '@mymind/core/lib/agent/judge/types'
import { judgeConfidenceError } from './judge-display'

export interface JudgeForm {
  enabled: boolean
  workstreams: boolean
  chat: boolean
  /** A string while typing, so a half-typed or out-of-range value stays visible with its error. */
  confidence: string | number
}

export function formFrom(j: JudgeSettings): JudgeForm {
  return { enabled: j.enabled, workstreams: j.smartApprovals.workstreams, chat: j.smartApprovals.chat, confidence: String(j.confidence) }
}

/** M2: the confidence only matters while the judge is on — switched off, a bad value never blocks
 *  saving "off" (and is not sent). */
export function formConfidenceError(f: JudgeForm): string | null {
  return f.enabled ? judgeConfidenceError(f.confidence) : null
}

/** The PUT body. The confidence goes only when it is valid (so "off" with a bad value keeps the stored one). */
export function patchFor(f: JudgeForm): { judge: { enabled: boolean; smartApprovals: { workstreams: boolean; chat: boolean }; confidence?: number } } {
  const ok = judgeConfidenceError(f.confidence) === null
  return {
    judge: {
      enabled: f.enabled,
      smartApprovals: { workstreams: f.workstreams, chat: f.chat },
      ...(ok ? { confidence: Number(f.confidence) } : {})
    }
  }
}

/** Whether saving would change anything stored. */
export function isDirty(f: JudgeForm, saved: JudgeSettings | null): boolean {
  if (!saved) return false
  const p = patchFor(f).judge
  return p.enabled !== saved.enabled
    || p.smartApprovals.workstreams !== saved.smartApprovals.workstreams
    || p.smartApprovals.chat !== saved.smartApprovals.chat
    || (p.confidence !== undefined && p.confidence !== saved.confidence)
}

/** `corrupt`: the stored doc had fields the worker reads fail-closed (GET `problems`) — shown as such,
 *  with a reset, never as if Tony had switched things off. `failed`: the GET itself failed. */
export type LoadState = 'loading' | 'ok' | 'failed' | 'corrupt'

/** The load state for a GET response. */
export function loadStateOf(res: { problems?: unknown }): LoadState {
  // Cycle 86: the taint-confinement switch has its own control (and reads a corrupt value as on).
  return Array.isArray(res.problems) && res.problems.some(p => p !== 'taintConfinement') ? 'corrupt' : 'ok'
}

/** Save is offered only for a loaded form with a real change and no error, while not already saving. */
export function canSave(f: JudgeForm, saved: JudgeSettings | null, load: LoadState, saving: boolean): boolean {
  return load === 'ok' && !saving && isDirty(f, saved) && formConfidenceError(f) === null
}
