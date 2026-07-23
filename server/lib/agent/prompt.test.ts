import { describe, it, expect } from 'vitest'
import { composePrompt } from './prompt'

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
