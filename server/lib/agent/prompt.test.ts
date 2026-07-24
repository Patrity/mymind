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
      const p = composePrompt({ ...base, speak })
      expect(p).toMatch(/LXC 114/)
      expect(p).toMatch(/mymind-db/)                 // Postgres is this docker container
      expect(p).toMatch(/not sqlite/i)
      expect(p).toMatch(/\/opt\/mymind/)             // its own source/docs are readable
      expect(p).toMatch(/harness Tony built/i)
    })
  }
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
