import { describe, it, expect } from 'vitest'
import { composePrompt, renderSkillsIndex } from './prompt'

const base = { persona: 'You are Bridget.', toneLine: 'It is afternoon.' }

describe('composePrompt — IMAGES rule', () => {
  // Regression guard: the model once copied a history image placeholder as its reply text
  // ("generated image: a t-rex...") and never called the tool, so no image rendered. The
  // IMAGES rule (always call the tool; never write image text) is the primary defense.
  for (const speak of [true, false]) {
    it(`includes the image-handling rule (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/generate_image/)
      expect(p).toMatch(/edit_image/)
      expect(p).toMatch(/never write image/i)
      expect(p).toMatch(/automatically/i)
    })
  }
})

describe('composePrompt — honesty invariant', () => {
  for (const speak of [true, false]) {
    it(`forbids claiming an action done without a tool result (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/never report an action as done/i)
      expect(p).toMatch(/fabricated success is the worst/i)
      expect(p).toMatch(/have not verified with a tool/i)
    })
  }
})

describe('composePrompt — environment self-model', () => {
  for (const speak of [true, false]) {
    it(`states the real runtime topology (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak, host: { hostname: 'bridget.local', platform: 'darwin', user: 'bridget' } })
      // Cycle 86: Bridget's own Mac (user `bridget`); MyMind runs there, its DB on Tony's Postgres.
      expect(p).toContain('your own Mac (`bridget.local`, macOS; you are the user `bridget`)')
      expect(p).toContain('Absolute paths reach anywhere on the Mac.')
      expect(p).toMatch(/database on Tony's Postgres server/)
      expect(p).toMatch(/harness Tony built/i)
      expect(p).not.toMatch(/LXC 114|mymind-db|\/opt\/mymind/)
    })
  }
})

describe('composePrompt — the SHELL host comes from runtime facts (final review M2)', () => {
  it('names the real host, OS and user — never a hardcoded Mac mini', () => {
    const p = composePrompt({ ...base, speak: false, host: { hostname: 'tonys-mbp', platform: 'darwin', user: 'tony' } })
    expect(p).toContain('your own Mac (`tonys-mbp`, macOS; you are the user `tony`)')
    expect(p).not.toMatch(/Mac mini|user `bridget`/)
    const lx = composePrompt({ ...base, speak: false, host: { hostname: 'mymind', platform: 'linux', user: 'root' } })
    expect(lx).toContain('your own machine (`mymind`, linux; you are the user `root`)')
    expect(lx).toContain('runs on this machine too')
    expect(lx).not.toMatch(/\bMac\b/)
    expect(lx).toContain('Load the `workspace` toolset')
  })

  it('defaults to this process\'s host', async () => {
    const os = await import('node:os')
    expect(composePrompt({ ...base, speak: false })).toContain(`(\`${os.hostname()}\`, `)
  })
})

describe('composePrompt — detail migrated into skills', () => {
  it('no longer carries the long web-research detail inline', () => {
    const p = composePrompt({ ...base, speak: false })
    expect(p).not.toMatch(/eBay/i)          // now in the web-research-etiquette skill
    expect(p).not.toMatch(/price-tracker/i)
    expect(p).not.toMatch(/diminishing returns/i)
  })
  it('keeps a one-line pointer to the web tools', () => {
    const p = composePrompt({ ...base, speak: false })
    expect(p).toMatch(/web_search/)
  })
  it('is meaningfully smaller than before the migration', () => {
    // MEASURED baseline: the pre-migration prompt is 6187 chars, and the four
    // web bullets being removed total 1311 chars; the single replacement
    // pointer line adds ~330. Expected post-shrink ≈ 5200, so 5600 proves a
    // real shrink with headroom. Do NOT relax this to make a failure pass —
    // if it fails, the bullets were not actually removed.
    const p = composePrompt({ ...base, speak: false })
    expect(p.length).toBeLessThan(5600)
  })
})

describe('skills index (Tier-1)', () => {
  const skills = [
    { name: 'db-maintenance', description: 'Safe Postgres ops', whenToUse: 'Use when touching the DB' },
    { name: 'deploy-and-migrate', description: 'Ship a change', whenToUse: 'Use when deploying' }
  ]
  it('renders one line per skill with the imperative load rule', () => {
    const idx = renderSkillsIndex(skills)
    expect(idx).toMatch(/use_skill/)
    expect(idx).toMatch(/db-maintenance: Safe Postgres ops/)
    expect(idx).toMatch(/Use when touching the DB/)
    expect(idx).toMatch(/deploy-and-migrate/)
  })
  it('is absent from the prompt when no index is supplied', () => {
    const p = composePrompt({ ...base, speak: false })
    expect(p).not.toMatch(/use_skill/)
  })
  it('is included when supplied', () => {
    const p = composePrompt({ ...base, speak: false, skillsIndex: renderSkillsIndex(skills) })
    expect(p).toMatch(/use_skill/)
    expect(p).toMatch(/db-maintenance/)
  })
  it('renders nothing for an empty skill list', () => {
    expect(renderSkillsIndex([])).toBe('')
  })
})

describe('composePrompt — on-demand toolsets wording (final review I1)', () => {
  // Regression guard: a fresh thread hides generate_image/edit_image/search_projects/etc until
  // loaded. The old "If you lack a tool or capability… say so plainly and stop" line, read
  // literally by a small model, produced a confident refusal instead of a `load_toolsets` call —
  // nothing in logs flagged it. Pin that the lack-a-tool rule now sends the model to the
  // directory first.
  for (const speak of [true, false]) {
    it(`the lack-a-tool rule points at TOOLSETS and load_toolsets before giving up (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/check TOOLSETS/)
      expect(p).toMatch(/load_toolsets/)
      expect(p).toMatch(/only if no toolset covers it, say so plainly and stop/i)
    })

    it(`the IMAGES rule names the images toolset (speak=${speak})`, () => {
      const p = composePrompt({ ...base, speak })
      const imagesLine = p.split('\n').find(l => l.startsWith('- IMAGES'))
      expect(imagesLine).toBeTruthy()
      expect(imagesLine).toMatch(/`images` toolset/)
      expect(imagesLine).toMatch(/load_toolsets/)
    })
  }
})

describe('composePrompt — toolset directory', () => {
  it('renders the toolset directory after the tool rules and before skills', () => {
    const p = composePrompt({ persona: 'P', speak: false, toneLine: 't', toolsetDirectory: 'TOOLSETS — x', skillsIndex: 'SKILLS — y' })
    expect(p).toContain('TOOLSETS — x')
    expect(p.indexOf('TOOLSETS — x')).toBeLessThan(p.indexOf('SKILLS — y'))
    expect(p.indexOf('SHELL —')).toBeLessThan(p.indexOf('TOOLSETS — x'))
  })
})

// Cycle 81 (spec §5.2): a workstream segment's prompt = goal + budget left + the autonomy rules, and
// no chat-only confirm-first rule (nobody is there to say yes).
describe('composePrompt — workstream block', () => {
  const goal = 'Compare three NAS options and write a recommendation doc'
  const w = { goal, used: { steps: 120, wallMs: 30 * 60_000 }, budget: { maxSteps: 400, maxWallMs: 120 * 60_000 } }
  it('carries the goal, the budget left and the rules', () => {
    const p = composePrompt({ ...base, speak: false, workstream: w })
    expect(p).toContain(`Goal: ${goal}`)
    expect(p).toContain('280 of 400 steps, 90 of 120 min left')
    expect(p).toMatch(/ask_tony.*ONLY when you are truly blocked/)
    expect(p).toMatch(/finish_workstream.*summary/)
    expect(p).not.toMatch(/DELETES are different/)
  })
  it('the final step says it is stopping and has no tools', () => {
    const p = composePrompt({ ...base, speak: false, workstream: { ...w, final: { reason: 'step budget used up (400 of 400 steps)' } } })
    expect(p).toContain('It is stopping: step budget used up (400 of 400 steps)')
    expect(p).toMatch(/no tools now/)
    expect(p).not.toMatch(/ask_tony/)
  })
  it('a chat prompt has no workstream block', () => {
    expect(composePrompt({ ...base, speak: false })).not.toMatch(/WORKSTREAM/)
  })
  it('stays within its own size cap (the goal aside)', () => {
    // Deliberate, workstream-only cap (the chat cap of 5600 above is untouched): the block's fixed
    // text measured ~400 chars over the chat prompt (2026-10-11), minus the dropped confirm-first
    // rule. 6100 = the chat cap + 500, so a block that grows past a few lines fails here. The goal is
    // Tony's/Bridget's own text (≤ 4000 chars, tools/workstreams.ts) and is excluded.
    const p = composePrompt({ ...base, speak: false, workstream: w })
    expect(p.length - goal.length).toBeLessThan(6100)
  })
})
