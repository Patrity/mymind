// server/lib/agent/signals/classify.ts
// Cycle 76 (spec §3): the pure half of engagement signals. What kind of signal a reply's text or
// a tapback on a job's message is. The DB writes live in ./write.ts.
import type { Tapback } from '../../channels/types'

export type SignalKind = 'replied' | 'tapback_positive' | 'tapback_negative' | 'said_stop' | 'said_thanks' | 'ignored'

/** A job message's observation window: Tony's reply or tapback within it counts; past it with
 *  nothing, the message is `ignored`. */
export const OBSERVATION_WINDOW_MS = 2 * 60 * 60 * 1000

const STOP = ['stop', 'not useful', "don't send", 'dont send', 'unsubscribe', 'too many']
const THANKS = ['thanks', 'thank you', 'helpful', 'perfect', 'nice']

/** A negation right before a phrase flips it: "don't stop", "do not stop" (via `not`),
 *  "not helpful", "no thanks". */
const NEGATION = String.raw`(?:don't|dont|not|never|no)\s+`

/**
 * Whole words only: "stopwatch" is not "stop", and a hyphen joins words too ("non-stop"). A
 * phrase's spaces match any run of whitespace. A negated phrase does not count.
 */
function lexicon(words: string[]): RegExp {
  const alts = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
  const edge = String.raw`[\p{L}\p{N}_\-]`
  return new RegExp(`(?<!${edge})(?<!(?<!${edge})${NEGATION})(?:${alts.join('|')})(?!${edge})`, 'iu')
}
const STOP_RE = lexicon(STOP)
const THANKS_RE = lexicon(THANKS)

/** The extra signals a reply's text carries, each at most once, stop first. iPhone autocorrect
 *  writes a curly apostrophe (don’t), so it is folded to a straight one first. */
export function classifyReplyText(text: string): ('said_stop' | 'said_thanks')[] {
  const t = text.replace(/[\u2018\u2019]/g, '\'')
  const out: ('said_stop' | 'said_thanks')[] = []
  if (STOP_RE.test(t)) out.push('said_stop')
  if (THANKS_RE.test(t)) out.push('said_thanks')
  return out
}

/** love/like/laugh/emphasize → positive; dislike → negative; question says nothing either way. */
export function tapbackSignal(t: Tapback): 'tapback_positive' | 'tapback_negative' | null {
  switch (t) {
    case 'love': case 'like': case 'laugh': case 'emphasize': return 'tapback_positive'
    case 'dislike': return 'tapback_negative'
    case 'question': return null
  }
}
