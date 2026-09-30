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
  'One proposal per distinct lesson; never merge unrelated lessons into one proposal.',
  'A procedure (where or how to do something) is a skill, never a profile edit; a preference about Tony is a profile edit, never a skill.',
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

/** Each active skill's file is shown up to 2 KB, all of them together up to 16 KB (Task 7 ruling). */
export const SKILL_FILE_SHOWN_MAX = 2048
export const SKILL_FILES_TOTAL_MAX = 16384
const TRUNCATED = '\n[… truncated]'

export interface PromptSkill {
  name: string
  description: string
  source: 'human' | 'agent'
  /** The skill's markdown file. Absent → listed by name only. */
  content?: string
  active?: boolean
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

function truncateBytes(s: string, max: number): string {
  let out = s.slice(0, max)
  while (bytes(out) > max) out = out.slice(0, -1)
  return out
}

/**
 * Which skill files go in the thread prompt: every ACTIVE skill's file, cut to 2 KB each, while
 * the total stays within 16 KB; the rest are listed by name only. `full` is true only when the
 * whole file was shown — a skill.edit replaces the whole file, so it may only target those
 * (anything else is written blind and is dropped as `body_not_shown`).
 */
export function skillFilesForPrompt(skills: PromptSkill[]): Map<string, { text: string; full: boolean }> {
  const out = new Map<string, { text: string; full: boolean }>()
  let used = 0
  for (const s of skills) {
    if (s.active === false || !s.content) continue
    const full = bytes(s.content) <= SKILL_FILE_SHOWN_MAX
    const text = full ? s.content : truncateBytes(s.content, SKILL_FILE_SHOWN_MAX - bytes(TRUNCATED)) + TRUNCATED
    if (used + bytes(text) > SKILL_FILES_TOTAL_MAX) continue
    used += bytes(text)
    out.set(s.name, { text, full })
  }
  return out
}

export function threadReflectionMessages(i: {
  transcript: string
  skills: PromptSkill[]
  profile: string
  recentRejections: string[]
}): ChatMessage[] {
  const skills = i.skills.length
    ? i.skills.map(s => `- ${s.name} (authored by ${s.source === 'agent' ? 'Bridget' : 'Tony'}): ${s.description}`).join('\n')
    : '(none)'
  const files = skillFilesForPrompt(i.skills)
  const fileBlocks = files.size
    ? [...files].map(([name, f]) => `### ${name}${f.full ? '' : ' (truncated — cannot be edited)'}\n${f.text.trim()}`).join('\n\n')
    : '(none)'
  const rejections = i.recentRejections.length ? i.recentRejections.map(r => `- ${r}`).join('\n') : '(none)'
  const user = [
    '## Existing skills', skills, '',
    '## Skill files', 'A skill.edit may only target a skill whose full file is shown here; it replaces the whole file.', fileBlocks, '',
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
