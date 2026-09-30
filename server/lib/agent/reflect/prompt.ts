// server/lib/agent/reflect/prompt.ts
//
// Prompts for the two reflector passes. The reflector has no tools: everything it sees is in
// these messages, and everything it can do is emit proposals, which plain code then gates.
import type { ChatMessage } from '../../ai/chat'
import { PROFILE_TOKEN_BUDGET } from '../profile-budget'

/** Spec: skill ≤ 4 KB. Stated to the model so it doesn't spend a proposal the gate will drop. */
export const REFLECT_SKILL_MAX_BYTES = 4096

const SHARED_RULES = [
  'Every proposal must include 1–5 exact quotes copied verbatim from the transcript as evidence.',
  'Never propose tools, permissions, commands to run, or secrets.',
  'Output JSON only: {"proposals": [...]}.'
].join(' ')

const PROPOSAL_SHAPE = 'Each proposal is {"kind", "target", "content", "reason", "confidence" (0–1), "evidence": ["exact quote", ...]}.'

export const THREAD_SYSTEM_PROMPT = [
  'You review Bridget\'s recent work and propose at most 3 improvements.',
  'Most threads warrant NONE, and an empty list is the right answer.',
  'Propose a skill only for a reusable procedure she worked out or was corrected into; propose a profile edit only for a preference Tony stated or clearly showed.',
  SHARED_RULES,
  '',
  PROPOSAL_SHAPE,
  'Kinds:',
  '- "skill.create": target is the new skill\'s name (lowercase-hyphenated); content is the full skill file (YAML frontmatter with name, description, when_to_use, then the markdown body).',
  '- "skill.edit": target is an existing skill\'s name; content is the full new skill file.',
  '- "profile.edit": target is "profile"; content is the FULL new profile, not a diff.',
  `Size limits: a skill file must be at most 4 KB (${REFLECT_SKILL_MAX_BYTES} bytes); the profile must be at most ${PROFILE_TOKEN_BUDGET.toLocaleString('en-US')} tokens (about ${(PROFILE_TOKEN_BUDGET * 4).toLocaleString('en-US')} characters). Anything larger is discarded.`,
  'Do not re-propose anything listed under recently rejected.'
].join('\n')

export const JOBS_SYSTEM_PROMPT = [
  'You review how Tony responded to Bridget\'s scheduled jobs over the last 14 days and propose at most 3 improvements.',
  'Most jobs warrant NONE, and an empty list is the right answer.',
  'Propose a change only when the signals and snippets show Tony\'s response to that job\'s messages.',
  SHARED_RULES.replace('from the transcript', 'from the job\'s snippets'),
  '',
  PROPOSAL_SHAPE,
  'Kinds:',
  '- "job.edit": target is the job slug; content is the full new job file (wording, trigger schedule or active_hours may change; keep the frontmatter valid).',
  '- "job.disable": target is the job slug; no content.'
].join('\n')

export function threadReflectionMessages(i: {
  transcript: string
  skills: { name: string; description: string; source: 'human' | 'agent' }[]
  profile: string
  recentRejections: string[]
}): ChatMessage[] {
  const skills = i.skills.length
    ? i.skills.map(s => `- ${s.name} (authored by ${s.source === 'agent' ? 'Bridget' : 'Tony'}): ${s.description}`).join('\n')
    : '(none)'
  const rejections = i.recentRejections.length ? i.recentRejections.map(r => `- ${r}`).join('\n') : '(none)'
  const user = [
    '## Existing skills', skills, '',
    '## Current profile of Tony', i.profile.trim() || '(empty)', '',
    '## Recently rejected proposals (last 30 days)', rejections, '',
    '## Transcript', i.transcript
  ].join('\n')
  return [{ role: 'system', content: THREAD_SYSTEM_PROMPT }, { role: 'user', content: user }]
}

export function jobsReflectionMessages(i: {
  jobs: { slug: string; content: string; source: string; signals: Record<string, number>; snippets: string[] }[]
}): ChatMessage[] {
  const jobs = i.jobs.map((j) => {
    const signals = Object.entries(j.signals).map(([k, n]) => `${k}: ${n}`).join(', ') || '(none)'
    const snippets = j.snippets.length ? j.snippets.map(s => `- ${s}`).join('\n') : '(none)'
    return [
      `## Job ${j.slug} (authored by ${j.source === 'agent' ? 'Bridget' : 'Tony'})`,
      '### Job file', j.content.trim(), '',
      '### Signals (last 14 days)', signals, '',
      '### Snippets', snippets
    ].join('\n')
  })
  return [
    { role: 'system', content: JOBS_SYSTEM_PROMPT },
    { role: 'user', content: jobs.join('\n\n') || '(no jobs)' }
  ]
}
