// Cycle 84 (spec §3.2): the output guard's heuristic tier — pure, synchronous, no I/O.
//
// It scores untrusted tool output (web pages, mail, workspace files and command output, child
// reports) for prompt injection. Two thresholds, deliberately far apart (Review Focus 4 — a taint
// is costly: outbound calls need approval and the sandbox loses its network):
//   - SUSPICIOUS: worth a second opinion — the guard's LLM tier is asked (guard.ts).
//   - FLAG: the heuristics alone flag the result. Only STRONG signals do that, or a pile-up of
//     independent ones. Text that DISCUSSES injection (security articles, OWASP pages, CTF
//     write-ups, test data) quotes exactly the phrases below, so in that context only the signals
//     that never appear in honest prose (Unicode tag smuggling, instructions hidden in base64) flag
//     on their own; everything else is left to the LLM tier.
//
// Labels are a fixed vocabulary (GUARD_LABELS): they reach the model-visible warning and the
// activity log, so they must never carry any of the scanned text.

/** Score at or above which the LLM tier is consulted (spec D9 "suspicious"). */
export const SUSPICIOUS_SCORE = 3
/** Score at or above which (with ≥ FLAG_MIN_CATEGORIES distinct instruction categories) the
 *  heuristics flag on their own — outside a discussion context. */
export const FLAG_SCORE = 10
export const FLAG_MIN_CATEGORIES = 3
/** Only this much text is scanned (the tools cap far below this; a defensive bound). */
export const SCAN_MAX_CHARS = 200_000

export type GuardLabel =
  | 'override' | 'persona' | 'ai-address' | 'concealment' | 'role-marker' | 'fake-system'
  | 'tool-call' | 'exfil' | 'exfil-image' | 'exfil-link' | 'invisible-tags' | 'zero-width' | 'bidi'
  | 'hidden-instructions' | 'encoded-instructions' | 'base64-imperative' | 'discusses-injection'

/** Plain-text descriptions (model-visible warning, UI chip). */
export const GUARD_LABELS: Record<GuardLabel, string> = {
  'override': 'asks to ignore previous instructions',
  'persona': 'tries to change your role or rules',
  'ai-address': 'addresses an AI reading it',
  'concealment': 'asks to hide something from the user',
  'role-marker': 'contains chat role markers',
  'fake-system': 'imitates a system or admin message',
  'tool-call': 'tells you to call a tool',
  'exfil': 'asks to send private data somewhere',
  'exfil-image': 'an image whose URL would carry data off',
  'exfil-link': 'a link whose URL would carry data off',
  'invisible-tags': 'hidden Unicode tag characters',
  'zero-width': 'many zero-width characters',
  'bidi': 'bidirectional control characters',
  'hidden-instructions': 'instructions inside hidden markup',
  'encoded-instructions': 'instructions hidden in base64',
  'base64-imperative': 'a base64 blob next to instructions',
  'discusses-injection': 'discusses prompt injection'
}

const WEIGHTS: Record<GuardLabel, number> = {
  'override': 4,
  'persona': 3,
  'ai-address': 4,
  'concealment': 4,
  'role-marker': 3,
  'fake-system': 3,
  'tool-call': 3,
  'exfil': 4,
  'exfil-image': 6,
  'exfil-link': 4,
  'invisible-tags': 8,
  'zero-width': 3,
  'bidi': 2,
  'hidden-instructions': 6,
  'encoded-instructions': 8,
  'base64-imperative': 3,
  'discusses-injection': 0
}

/** Instruction-shaped categories (the pile-up rule counts distinct ones). */
const INSTRUCTION_LABELS: ReadonlySet<GuardLabel> = new Set<GuardLabel>([
  'override', 'persona', 'ai-address', 'concealment', 'role-marker', 'fake-system', 'tool-call', 'exfil', 'exfil-link'
])
/** Never seen in honest prose: these flag on their own, even in a discussion context. */
const NEVER_BENIGN: ReadonlySet<GuardLabel> = new Set<GuardLabel>(['invisible-tags', 'encoded-instructions'])
/** Strong outside a discussion context (an article explaining them shows them as examples). */
const STRONG: ReadonlySet<GuardLabel> = new Set<GuardLabel>(['invisible-tags', 'encoded-instructions', 'hidden-instructions', 'exfil-image'])

export interface HeuristicResult {
  score: number
  labels: GuardLabel[]
  suspicious: boolean
  flagged: boolean
  /** Char offsets of the matches (guard.ts cuts the LLM excerpt around them). */
  hits: number[]
}

// ---- patterns ------------------------------------------------------------------------------

const OVERRIDE = [
  /\b(ignore|disregard|forget|override|bypass|discard)\b[^.\n]{0,40}?\b(previous|prior|above|earlier|preceding|original|existing|system|all)\b[^.\n]{0,25}?\b(instructions?|prompts?|rules|directions|directives|guidelines|commands)\b/gi,
  /\bnew (system )?instructions?\s*:/gi,
  // The same override in the languages Tony's mail and browsing most often meet.
  /\bignora\s+(?:todas\s+)?las\s+instrucciones\s+(?:anteriores|previas)\b/gi,
  /\bignore[sz]?\s+(?:toutes\s+)?les\s+instructions\s+(?:pr[ée]c[ée]dentes|ant[ée]rieures)\b/gi,
  /\bignorier(?:e|en)?\s+(?:alle\s+)?(?:vorherigen|bisherigen|vorigen)\s+(?:Anweisungen|Instruktionen)\b/gi
]
const PERSONA = [
  /\byou are now\b/gi,
  /\bfrom now on,? (you|your)\b/gi,
  /\bdo anything now\b/gi,
  /\b(developer|jailbr(?:eak|oken)|god|unrestricted) mode\b/gi,
  /\byour (new )?(role|task|goal|instructions?) (is|are) now\b/gi
]
const AI_NOUN = '(?:ai|a\\.i\\.|llm|large language model|language model|ai assistant|assistant|ai agent|agent|chatbot|gpt|chatgpt|claude|bridget|copilot|gemini|model)s?'
const AI_ADDRESS = [
  new RegExp(`\\b(?:if you are|if you're|attention|note to|notice to|message (?:to|for)|instructions? (?:to|for)|dear|hey|hi|hello)[,:]?\\s+(?:an?\\s+|the\\s+|all\\s+|any\\s+)?${AI_NOUN}\\b`, 'gi'),
  new RegExp(`\\b${AI_NOUN}\\s+(?:reading|processing|summari[sz]ing|parsing|browsing|viewing|scanning|analy[sz]ing)\\s+(?:this|these)\\b`, 'gi'),
  /\bwhen you (?:read|process|summari[sz]e|parse|see) this\b/gi
]
const CONCEALMENT = [
  /\b(?:do not|don't|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|reveal(?:ing)?|notify(?:ing)?|alert(?:ing)?|let(?:ting)?|show(?:ing)?|disclos(?:e|ing))\s+(?:this\s+(?:note\s+|message\s+)?(?:to\s+)?|it\s+(?:to\s+)?|anything\s+(?:to\s+)?)?(?:the\s+)?(?:user|tony|human|owner|operator)\b/gi,
  /\bkeep (?:this|it) (?:a )?secret from\b/gi,
  /\b(?:do not|don't|never)\s+(?:reveal|mention|disclose|acknowledge)\s+(?:this|these)\s+(?:note|instructions?|message)\b/gi
]
const ROLE_MARKER = [
  /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id)\|>/g,
  /\[\/?INST\]/g,
  /<<\/?SYS>>/g,
  /^\s*#{1,4}\s*(?:system|assistant)(?:\s+(?:message|prompt))?\s*:?\s*$/gim
]
const FAKE_SYSTEM = [
  /\b(?:SYSTEM|ADMIN|ADMINISTRATOR|DEVELOPER|OPERATOR)\s+(?:NOTICE|MESSAGE|OVERRIDE|INSTRUCTIONS?|UPDATE|ALERT|PROMPT)\b/g,
  /<\/?(?:system|system_prompt|instructions)>/gi,
  /\[\[?\s*(?:SYSTEM|ASSISTANT|ADMIN)\b[^\]\n]{0,30}\]\]?/g
]
const TOOL_NAMES = 'gmail_send|gmail_draft|gmail_modify|web_fetch|web_search|research_web|send_message|create_job|edit_job|run_job|schedule_wake|spawn_workstreams|steer_workstream|calendar_guest_event|calendar_write_event|calendar_rsvp|save_memory|forget_memory|delete_document|write_file|delete_files|export_to_document|create_skill|edit_skill'
const TOOL_CALL = [
  new RegExp(`\\b(?:call|use|run|invoke|execute|trigger)\\s+(?:the\\s+)?\`?(?:${TOOL_NAMES})\`?`, 'gi'),
  /\b(?:call|use|run|invoke)\s+the\s+`?(?:exec|bash)`?\s+tool\b/gi
]
const PRIVATE_DATA = '(?:e-?mails?|inbox|mailbox|messages|conversation|chat history|history|passwords?|credentials|api[ -]?keys?|tokens?|secrets?|ssh keys?|private keys?|\\.env|contacts|calendar|files|documents|memor(?:y|ies)|system prompt)'
const EXFIL = new RegExp(`\\b(send|forward|e-?mail|post|upload|exfiltrate|leak|transmit|append|include|encode|paste)\\b[^.\\n]{0,60}?\\b(?:the user'?s?|tony'?s|his|her|their|the owner'?s|all(?: of)?(?: the)?|every|the last \\d+|the contents of(?: the)?)\\s+(?:\\w+\\s+){0,2}?${PRIVATE_DATA}\\b`, 'gi')
const NEGATION_BEFORE = /\b(?:never|not|n't|don't|do not|cannot|can't|won't)\b[^.\n]{0,25}$/i
// Upper-case template words (INSERT_API_KEY, {DATA}, $SECRET): an ordinary query (`?token=abc`,
// `?w=800`) never matches.
const PLACEHOLDER = /\{[^}\n]{1,60}\}|%7B|\[[A-Z_ ]{3,40}\]|<[A-Z_ ]{3,40}>|\$\{?[A-Z_]{3,}|INSERT|YOUR_|USER_|(?:DATA|SECRET|CONVERSATION|SUMMARY|PASSWORD|API_?KEY|TOKEN)(?![a-z])/
const MD_IMAGE = /!\[[^\]\n]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)|<img\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi
const MD_LINK = /(?<!!)\[[^\]\n]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)/gi
const DISCUSSION = /\bprompt[- ]injections?\b|\bjailbreak(?:s|ing)?\b|\bred[- ]team(?:ing|ers?)?\b|\badversarial (?:prompts?|inputs?|attacks?)\b|\bOWASP\b|\bguardrails?\b|\b(?:attack(?:s|ers?)?|exploits?|vulnerabilit(?:y|ies)|payloads?|mitigations?|researchers?)\b/gi
const HIDDEN_MARKUP = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\s*[;"']|opacity\s*:\s*0(?:\.0+)?\s*[;"']|color\s*:\s*(?:#fff(?:fff)?|white|transparent)\b|<!--/gi
const BASE64 = /[A-Za-z0-9+/]{120,}={0,2}/g
const IMPERATIVE_NEAR = /\b(?:decode|follow|execute|run|eval|instructions?|obey)\b/i

/** Unicode tag characters (U+E0000–U+E007F): invisible, and map 1:1 onto ASCII ("ASCII smuggling"). */
const TAGS = /[\u{E0000}-\u{E007F}]/gu
/** Zero-width characters — ZWJ (U+200D) excluded: every multi-person emoji is built with it. */
const ZERO_WIDTH = /[​‌⁠-⁤﻿᠎]/g
/** Embedding/override/isolate controls — LRM/RLM (U+200E/F) excluded: normal in RTL text. */
const BIDI = /[‪-‮⁦-⁩]/g

// ---- scanning ------------------------------------------------------------------------------

function firstHits(text: string, patterns: RegExp[]): number[] {
  const out: number[] = []
  for (const p of patterns) {
    p.lastIndex = 0
    const m = p.exec(text)
    if (m) out.push(m.index)
    p.lastIndex = 0
  }
  return out
}

/** The instruction categories present in `text` (used on the main text, decoded payloads and
 *  hidden-markup windows alike). */
function instructionLabels(text: string, hits?: number[]): GuardLabel[] {
  const found: GuardLabel[] = []
  const add = (label: GuardLabel, at: number[]) => {
    if (!at.length) return
    found.push(label)
    hits?.push(...at)
  }
  add('override', firstHits(text, OVERRIDE))
  add('persona', firstHits(text, PERSONA))
  add('ai-address', firstHits(text, AI_ADDRESS))
  add('concealment', firstHits(text, CONCEALMENT))
  add('role-marker', firstHits(text, ROLE_MARKER))
  add('fake-system', firstHits(text, FAKE_SYSTEM))
  add('tool-call', firstHits(text, TOOL_CALL))
  add('exfil', exfilHits(text))
  return found
}

function exfilHits(text: string): number[] {
  EXFIL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXFIL.exec(text))) {
    // "Never send your password by email" is advice, not an attempt.
    if (!NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index))) {
      EXFIL.lastIndex = 0
      return [m.index]
    }
  }
  return []
}

function urlCarriesData(url: string): boolean {
  const q = url.indexOf('?')
  if (q < 0) return false
  let query = url.slice(q + 1)
  try { query = decodeURIComponent(query) } catch { /* keep the raw query */ }
  return PLACEHOLDER.test(query)
}

function urlHits(text: string, re: RegExp): number[] {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = m[1] ?? m[2]
    if (url && urlCarriesData(url)) { re.lastIndex = 0; return [m.index] }
  }
  return []
}

/** Hidden markup (a CSS hiding rule, an HTML comment) followed by instruction-shaped text. */
function hiddenInstructionHits(text: string): number[] {
  HIDDEN_MARKUP.lastIndex = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = HIDDEN_MARKUP.exec(text)) && n++ < 50) {
    const isComment = m[0] === '<!--'
    const end = isComment ? text.indexOf('-->', m.index) : -1
    const window = isComment
      ? text.slice(m.index + 4, end < 0 ? m.index + 800 : Math.min(end, m.index + 800))
      : text.slice(m.index, m.index + 600)
    if (instructionLabels(window).some(l => l !== 'role-marker')) { HIDDEN_MARKUP.lastIndex = 0; return [m.index] }
  }
  return []
}

function looksLikeText(s: string): boolean {
  if (s.length < 20) return false
  let printable = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 32 && c < 127) || c === 10 || c === 13 || c === 9) printable++
  }
  return printable / s.length >= 0.9
}

/** Base64 blobs: decoded instructions (strong), or a text blob beside imperative words. */
function base64Labels(text: string, hits: number[]): GuardLabel[] {
  BASE64.lastIndex = 0
  let m: RegExpExecArray | null
  let n = 0
  let near = -1
  while ((m = BASE64.exec(text)) && n++ < 8) {
    const blob = m[0].slice(0, 8000)
    let decoded = ''
    try { decoded = Buffer.from(blob, 'base64').toString('latin1') } catch { continue }
    if (!looksLikeText(decoded)) continue
    if (instructionLabels(decoded).length) { BASE64.lastIndex = 0; hits.push(m.index); return ['encoded-instructions'] }
    const around = text.slice(Math.max(0, m.index - 200), m.index) + text.slice(m.index + m[0].length, m.index + m[0].length + 200)
    if (near < 0 && IMPERATIVE_NEAR.test(around)) near = m.index
  }
  BASE64.lastIndex = 0
  if (near >= 0) { hits.push(near); return ['base64-imperative'] }
  return []
}

function count(text: string, re: RegExp): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(text)) n++
  re.lastIndex = 0
  return n
}

/** Decode Unicode tag characters to the ASCII they smuggle. */
function decodeTags(text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xE0020 && cp <= 0xE007E) out += String.fromCharCode(cp - 0xE0000)
  }
  return out
}

/** Score `text` (pure). */
export function scoreText(input: string): HeuristicResult {
  const text = input.length > SCAN_MAX_CHARS ? input.slice(0, SCAN_MAX_CHARS) : input
  const hits: number[] = []
  const labels = new Set<GuardLabel>(instructionLabels(text, hits))

  const ex = urlHits(text, MD_IMAGE)
  if (ex.length) { labels.add('exfil-image'); hits.push(...ex) }
  const lk = urlHits(text, MD_LINK)
  if (lk.length) { labels.add('exfil-link'); hits.push(...lk) }
  const hidden = hiddenInstructionHits(text)
  if (hidden.length) { labels.add('hidden-instructions'); hits.push(...hidden) }
  for (const l of base64Labels(text, hits)) labels.add(l)

  const tags = count(text, TAGS)
  if (tags >= 4) {
    labels.add('invisible-tags')
    TAGS.lastIndex = 0
    const at = TAGS.exec(text)
    TAGS.lastIndex = 0
    if (at) hits.push(at.index)
    // What the tags spell is scanned too (its categories add to the score).
    for (const l of instructionLabels(decodeTags(text))) labels.add(l)
  }
  if (count(text, ZERO_WIDTH) >= 16) labels.add('zero-width')
  if (count(text, BIDI) >= 6) labels.add('bidi')

  // Discussion context: ≥ 3 mentions of security vocabulary, one of them naming the attack.
  DISCUSSION.lastIndex = 0
  const talk = text.match(DISCUSSION) ?? []
  const discusses = talk.length >= 3 && talk.some(w => /inject|jailbreak|red[- ]team|adversarial|owasp/i.test(w))
  if (discusses) labels.add('discusses-injection')

  const list = [...labels]
  const score = list.reduce((s, l) => s + WEIGHTS[l], 0)
  const categories = list.filter(l => INSTRUCTION_LABELS.has(l)).length
  const flagged = discusses
    ? list.some(l => NEVER_BENIGN.has(l))
    : list.some(l => STRONG.has(l)) || (score >= FLAG_SCORE && categories >= FLAG_MIN_CATEGORIES)
  return { score, labels: list, suspicious: score >= SUSPICIOUS_SCORE, flagged, hits: [...new Set(hits)].sort((a, b) => a - b) }
}

/** Notes our own tools attach to untrusted results — never scanned (they say "instructions"). */
export function stripOwnNotes(text: string, notes: readonly string[]): string {
  let t = text
  for (const n of notes) if (n) t = t.split(n).join(' ')
  return t
}

/**
 * Every string leaf of a tool result, joined by newlines — what the guard scans and the LLM reads.
 * Keys are not included (they are ours). `skipKeys` drops our own fields (the injection warning).
 */
export function resultText(result: unknown, skipKeys: ReadonlySet<string> = new Set()): string {
  const out: string[] = []
  let size = 0
  const walk = (v: unknown, depth: number) => {
    if (size > SCAN_MAX_CHARS || depth > 12) return
    if (typeof v === 'string') { out.push(v); size += v.length + 1; return }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!skipKeys.has(k)) walk(x, depth + 1)
    }
  }
  walk(result, 0)
  return out.join('\n')
}
