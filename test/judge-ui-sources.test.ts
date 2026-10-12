// Cycle 84 Task 4: verdict reasons, the auto-approval reason and the guard's reasons are MODEL OUTPUT
// (the guard's are steered by the very page it flagged). The components that show them must render
// them as escaped text only — `{{ }}` interpolation — never v-html, markdown (MessageResponse / MDC)
// or innerHTML. A source guard, because no component test can prove a renderer is NOT used.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const FILES = [
  'app/components/agent/JudgeVerdict.vue',
  'app/components/agent/OutputWarningChip.vue',
  'app/components/agent/ApprovalConfirmation.vue',
  'app/components/agent/ToolPart.vue',
  'app/components/settings/JudgeSettings.vue'
]
const RENDERERS = /v-html|innerHTML|MessageResponse|<MDC|<Comark|marked\(|markdown/i

describe('judge UI renders model output as plain text', () => {
  it.each(FILES)('%s uses no HTML/markdown renderer', (f) => {
    const template = read(f).replace(/<!--[\s\S]*?-->/g, '')
    expect(template).not.toMatch(RENDERERS)
  })

  it('verdict reasons, the rule reasons, the guard reasons and the auto note are {{ }} interpolations', () => {
    expect(read('app/components/agent/JudgeVerdict.vue')).toContain('{{ r }}')
    expect(read('app/components/agent/JudgeVerdict.vue')).toContain("{{ view.rule.reasons.join(' · ')")
    expect(read('app/components/agent/OutputWarningChip.vue')).toContain('{{ r }}')
    expect(read('app/components/agent/ToolPart.vue')).toContain('{{ autoNote }}')
  })

  it('the workstream attention verdict goes through the same component, not the hardened markdown', () => {
    const page = read('app/pages/workstreams/[id].vue')
    expect(page).toMatch(/<AgentJudgeVerdict\s+v-if="ws\.attention\.kind === 'approval' && ws\.attention\.judge"/)
  })
})
