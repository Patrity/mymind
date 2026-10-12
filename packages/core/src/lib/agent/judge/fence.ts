// Cycle 84: fencing untrusted text inside a judge / guard prompt (Review Focus 2). Each fence
// carries a random id minted per prompt, so text inside it cannot close the fence: a forged
// closing tag lacks the id, and any `<untrusted` / `</untrusted` already in the text is defanged.
import { randomBytes } from 'node:crypto'

/** A fresh fence id for one prompt. */
export function fenceId(): string {
  return randomBytes(6).toString('hex')
}

/** Wrap `text` as untrusted data under `label`. Callers may pass already-fenced text; it is fenced
 *  again (the inner fence is then just data). */
export function fenceUntrusted(id: string, label: string, text: string): string {
  const safe = text.replace(/<(\/?)untrusted/gi, '‹$1untrusted')
  const safeLabel = label.replace(/[^a-z0-9 _-]/gi, '')
  return `<untrusted id="${id}" label="${safeLabel}">\n${safe}\n</untrusted id="${id}">`
}
