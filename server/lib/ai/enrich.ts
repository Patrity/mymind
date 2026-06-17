import { chat } from './chat'
import type { DocumentDTO } from '../../../shared/types/documents'
import { capTags } from '../../../shared/utils/cap-tags'

export interface Proposed {
  title?: string
  project?: string | null
  domain?: string
  type?: string
  tags?: string[]
  path?: string
  reasoning?: string
}

export interface ProjectCandidate {
  slug: string
  name: string
  description: string
}

/**
 * Strip markdown fences, find the first {...} block, JSON.parse, validate,
 * and coerce tags. Returns null on any failure.
 */
export function parseProposal(raw: string): Proposed | null {
  if (!raw || !raw.trim()) return null

  try {
    // Strip ```json ... ``` or ``` ... ``` fences
    let text = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()

    // Find the first { ... } block (possibly with nested braces)
    const start = text.indexOf('{')
    if (start === -1) return null

    // Find the matching closing brace
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) return null

    const jsonStr = text.slice(start, end + 1)
    const parsed: unknown = JSON.parse(jsonStr)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const obj = parsed as Record<string, unknown>

    // Coerce tags: string[] is valid; string is coerced to [string]; anything else → null
    if (obj.tags !== undefined) {
      if (Array.isArray(obj.tags)) {
        // All items must be strings
        if (!obj.tags.every((t: unknown) => typeof t === 'string')) return null
      } else if (typeof obj.tags === 'string') {
        obj.tags = [obj.tags]
      } else {
        // Object, number, etc. — not coercible
        return null
      }
    }

    return {
      title: typeof obj.title === 'string' ? obj.title : undefined,
      project: (typeof obj.project === 'string' || obj.project === null) ? obj.project as string | null : undefined,
      domain: typeof obj.domain === 'string' ? obj.domain : undefined,
      type: typeof obj.type === 'string' ? obj.type : undefined,
      tags: Array.isArray(obj.tags) ? capTags(obj.tags as string[], 10) : undefined,
      path: typeof obj.path === 'string' ? obj.path : undefined,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined
    }
  } catch {
    return null
  }
}

const BASE_SYSTEM_PROMPT = `You organize a personal knowledge base. Given a staged note, propose frontmatter as STRICT JSON only (no prose). Fields: title (concise), project (kebab-case slug or null), domain (broad subject e.g. 'engineering','health','finance'), type (one of note|reference|meeting|idea|task), tags (array of kebab-case strings), path (a destination path moving the doc OUT of /input), reasoning (one sentence). Output ONLY the JSON object.`

/**
 * Pure helper: build the system + user messages for the enrichment AI call.
 * Extracted so it can be unit-tested without a live AI call.
 */
export function buildEnrichMessages(
  doc: DocumentDTO,
  projects: ProjectCandidate[]
): Array<{ role: 'system' | 'user'; content: string }> {
  const content = doc.content.slice(0, 6000)

  let systemPrompt = BASE_SYSTEM_PROMPT

  if (projects.length > 0) {
    const projectList = projects
      .map(p => `  ${p.slug} — ${p.name} — ${p.description}`)
      .join('\n')
    systemPrompt += `\n\nAvailable projects (slug — name — description):\n${projectList}\n\nChoose the single best-matching project SLUG from this list only, or set project to null if none clearly fits. If you choose a project, set \`path\` to \`/projects/<that-slug>/<current-filename>\` (keep the existing filename). If project is null, you may still propose a \`path\` but it must NOT be under /projects/.`
  } else {
    systemPrompt += `\n\nNo projects are available. Set project to null. You may still propose a \`path\` but it must NOT be under /projects/.`
  }

  const userMessage = `Path: ${doc.path}\n\nContent:\n${content}`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage }
  ]
}

export async function proposeFrontmatter(doc: DocumentDTO, projects: ProjectCandidate[] = []): Promise<Proposed | null> {
  const messages = buildEnrichMessages(doc, projects)

  try {
    const raw = await chat('reasoning', messages, { temperature: 0.1 })

    return parseProposal(raw)
  } catch (err) {
    console.warn('[proposeFrontmatter] AI call failed:', err)
    return null
  }
}
