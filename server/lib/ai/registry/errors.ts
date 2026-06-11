// server/lib/ai/registry/errors.ts
import type { Usage } from './types'

export class AiNotConfiguredError extends Error {
  constructor(public usage: Usage) {
    super(`No model is configured for "${usage}". Configure it in Settings.`)
    this.name = 'AiNotConfiguredError'
  }
}

export class AiAllFailedError extends Error {
  constructor(public usage: Usage, public attempts: { label: string; error: string }[]) {
    super(`All ${attempts.length} model(s) for "${usage}" failed: ${attempts.map(a => `${a.label} (${a.error})`).join('; ')}`)
    this.name = 'AiAllFailedError'
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigValidationError' }
}
