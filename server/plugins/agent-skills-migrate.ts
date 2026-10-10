// Cycle 74: moves pre-cycle-74 skill documents into agent_skills on boot. Idempotent — a slug
// already in agent_skills is skipped and moved documents are soft-deleted — so it is safe on
// every start. A data move, not a SQL migration, because rebuilding markdown from the jsonb
// frontmatter + body is fragile in SQL (see the cycle-74 plan's planning rulings).
import { migrateSkillsFromDocuments } from '@mymind/core/services/skills'

export default defineNitroPlugin(async () => {
  // No DB at prerender time (same guard as agent-runtime.ts).
  if (import.meta.prerender) return
  try {
    const { moved, skipped } = await migrateSkillsFromDocuments()
    console.info(`[agent-skills-migrate] moved ${moved} skill document(s) into agent_skills`)
    for (const s of skipped) console.warn(`[agent-skills-migrate] skipped ${s.path}: ${s.reason}`)
  } catch (err) {
    console.error('[agent-skills-migrate] skills data move failed:', err)
  }
})
