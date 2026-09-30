// server/lib/agent/reflect/jev.ts
//
// Jev as a one-way check on a reflector proposal (spec §5.7, D5). It asks OBSERVABLE questions
// only — the jev-score calibration showed taste questions ("is this valuable?") carry no signal —
// and a risky read can only demote `auto` to `review`; the gate never lets it promote anything.
// Unconfigured, unreachable or incomplete → 'unavailable', which the gate also treats as review
// (fail closed). The raw answers ride along so they can be stored for later calibration.
import { askJev, jevConfig, nouls, type JevConfig } from '../../ai/jev'
import type { Proposal } from './schema'

export interface JevVerdict { answers: Record<string, number>; risky: boolean; model: string }

/** An unwanted answer at or beyond this probability makes the proposal risky. */
export const JEV_BUMP = 0.6

type Question = { type: 'noul'; instructions: string; unwanted: 'high' | 'low' }

export const REFLECT_JEV_QUESTIONS: Record<'skill' | 'profile' | 'job', Record<string, Question>> = {
  skill: {
    one_off: { type: 'noul', instructions: 'Does this describe fixing one specific situation rather than a procedure that applies again?', unwanted: 'high' },
    time_bound: { type: 'noul', instructions: 'Is this tied to a specific date, event or temporary state?', unwanted: 'high' }
  },
  profile: {
    inferred: { type: 'noul', instructions: 'Is this preference inferred or guessed rather than stated by Tony in the evidence?', unwanted: 'high' },
    passing: { type: 'noul', instructions: 'Does the evidence describe a passing mood or one-off situation?', unwanted: 'high' }
  },
  job: {
    unrelated: { type: 'noul', instructions: 'Does the evidence describe something other than Tony\'s reaction to this job\'s messages?', unwanted: 'high' }
  }
}

function questionSet(kind: Proposal['kind']): Record<string, Question> {
  if (kind === 'profile.edit') return REFLECT_JEV_QUESTIONS.profile
  if (kind === 'job.edit' || kind === 'job.disable') return REFLECT_JEV_QUESTIONS.job
  return REFLECT_JEV_QUESTIONS.skill
}

/**
 * Ask Jev about `p`. `evidence` is the text Jev reads the proposal against — the caller passes the
 * same pass input the gate's evidence check uses (the transcript; for the jobs pass, the signal
 * snippets plus the job content). Never throws.
 */
export async function jevCheck(
  p: Proposal,
  evidence: string,
  deps: { ask?: typeof askJev; cfg?: JevConfig | null } = {}
): Promise<JevVerdict | 'unavailable'> {
  try {
    const cfg = deps.cfg === undefined ? await jevConfig() : deps.cfg
    if (!cfg) return 'unavailable'
    const qs = questionSet(p.kind)
    const questions = Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, { type: q.type, instructions: q.instructions }]))
    const state = [p.kind, p.target, p.content ?? '', p.reason, evidence].filter(s => s.trim()).join('\n\n')
    const res = await (deps.ask ?? askJev)(state, questions, cfg)
    const answers = nouls(res.answers)
    // A missing answer is not a safe answer: without every question read, Jev cannot vouch.
    if (Object.keys(qs).some(k => typeof answers[k] !== 'number')) return 'unavailable'
    const risky = Object.entries(qs).some(([k, q]) => (q.unwanted === 'high' ? answers[k]! : 1 - answers[k]!) >= JEV_BUMP)
    return { answers, risky, model: res.model }
  } catch {
    return 'unavailable'
  }
}
