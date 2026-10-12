// server/lib/ai/registry/errors.ts
import type { Usage } from './types'

export class AiNotConfiguredError extends Error {
  constructor(public usage: Usage) {
    super(`No model is configured for "${usage}". Configure it in Settings.`)
    this.name = 'AiNotConfiguredError'
  }
}

/** One failed chain member. `status` is the HTTP status when the provider answered with one. */
export interface FailedAttempt { label: string; error: string; status?: number }

export class AiAllFailedError extends Error {
  constructor(public usage: Usage, public attempts: FailedAttempt[]) {
    super(`All ${attempts.length} model(s) for "${usage}" failed: ${attempts.map(a => `${a.label} (${a.error})`).join('; ')}`)
    this.name = 'AiAllFailedError'
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigValidationError' }
}

/** A coordinator named a `subagents` model that is not in the list (cycle 83). Raised at spawn, so
 *  the model reads which labels exist and can pick again. */
export class UnknownSubagentModelError extends Error {
  constructor(public label: string, public available: string[]) {
    super(available.length
      ? `There is no subagents model labelled "${label}". Available: ${available.map(l => `"${l}"`).join(', ')}.`
      : `There is no subagents model labelled "${label}": no subagents models are configured, so children run on the reasoning model — leave the model out.`)
    this.name = 'UnknownSubagentModelError'
  }
}
