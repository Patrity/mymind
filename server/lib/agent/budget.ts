import { estimateTokens } from '../chunking/chunk-markdown'

/** A labelled block of prompt text with its estimated cost. */
export interface Tier { name: string, text: string, tokens: number }

export function tier(name: string, text: string): Tier {
  return { name, text, tokens: estimateTokens(text) }
}

/**
 * Thrown when the never-evicted tiers alone do not fit. This is a configuration error, not a
 * runtime condition to absorb: a self-nominating resident tier CAN grow past its allocation,
 * and silently truncating it would degrade every turn with nothing in the logs.
 */
export class ResidentOverflowError extends Error {
  constructor(public readonly fixedTokens: number, public readonly budget: number) {
    super(`fixed context tiers need ${fixedTokens} tokens but the budget is ${budget}`)
    this.name = 'ResidentOverflowError'
  }
}

/** Share of the total budget that recent turns are guaranteed, whatever retrieval wants. */
export const TURN_FLOOR_RATIO = 0.4

export interface FitInput {
  /** Never evicted: resident facts, live state, working summary. */
  fixed: Tier[]
  /** Oldest-first. Trimmed from the FRONT — the tail is what keeps the session coherent. */
  turns: Tier[]
  /** Best-first. Evicted from the BACK, before any turn is touched. */
  retrieved: Tier[]
  budget: number
  turnFloorRatio?: number
}

export interface FitResult {
  kept: { fixed: Tier[], turns: Tier[], retrieved: Tier[] }
  used: number
  droppedTurns: number
  droppedRetrieved: number
}

export function fitBudget(input: FitInput): FitResult {
  const { fixed, turns, retrieved, budget } = input
  const floorRatio = input.turnFloorRatio ?? TURN_FLOOR_RATIO

  const fixedTokens = fixed.reduce((a, t) => a + t.tokens, 0)
  if (fixedTokens > budget) throw new ResidentOverflowError(fixedTokens, budget)

  const available = budget - fixedTokens
  const turnFloor = Math.floor(budget * floorRatio)
  const retrievalWant = retrieved.reduce((a, t) => a + t.tokens, 0)
  const turnCeiling = Math.max(turnFloor, available - retrievalWant)

  // Pack turns newest-first (iterate backwards) up to turnCeiling, then reverse
  const keptTurnsReversed: Tier[] = []
  let turnTokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!
    if (turnTokens + t.tokens > turnCeiling) break
    keptTurnsReversed.push(t)
    turnTokens += t.tokens
  }
  const keptTurns = keptTurnsReversed.reverse()

  // Retrieval ceiling is what is left after turns.
  const retrievalCeiling = available - turnTokens
  const keptRetrieved: Tier[] = []
  let retrievedTokens = 0
  for (const t of retrieved) {
    if (retrievedTokens + t.tokens > retrievalCeiling) continue
    keptRetrieved.push(t)
    retrievedTokens += t.tokens
  }

  return {
    kept: { fixed, turns: keptTurns, retrieved: keptRetrieved },
    used: fixedTokens + turnTokens + retrievedTokens,
    droppedTurns: turns.length - keptTurns.length,
    droppedRetrieved: retrieved.length - keptRetrieved.length
  }
}
