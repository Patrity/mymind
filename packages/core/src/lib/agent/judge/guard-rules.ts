// Cycle 84 (spec §3.2): the output guard's heuristic tier — pure, synchronous, no I/O.
//
// Fix round 1 (ruling "restructure"): the heuristics are a ROUTER, not a judge.
//   - FLAG alone: only the near-zero-false-positive signals — Unicode tag-character smuggling and
//     chat-template role tokens (`<|im_start|>`, …) in running text (not inside code or a quoted
//     string, where docs and test data show them).
//   - Every other signal only marks the content SUSPICIOUS: the LLM tier decides (guard.ts). With
//     the judge unavailable or disabled, suspicious content is flagged (fail closed).
//   - There is no "discussion context" discount: an article ABOUT injection that also carries one is
//     the classifier's call, and an attacker can always add security vocabulary.
//
// Matching runs on a NORMALIZED copy (normalize()): NFKC; invisible characters, soft hyphens, bidi
// controls, variation selectors and markdown backslash-escapes stripped; common Cyrillic/Greek confusables folded to Latin;
// whitespace and newlines collapsed — so "Ignore all previous\ninstructions", ZWJ/soft-hyphen
// splits, sparse zero-width spaces, homoglyphs and fullwidth letters match like plain text. Hit
// offsets are mapped back to the ORIGINAL text (the LLM excerpt is cut from it).
//
// Labels are a fixed vocabulary (GUARD_LABELS): they reach the model-visible warning and the
// activity log, so they never carry any of the scanned text.

/** Score at or above which the content is suspicious (the LLM tier decides). */
export const SUSPICIOUS_SCORE = 3
/** Only this much text is scanned (the tools cap far below this; a defensive bound). */
export const SCAN_MAX_CHARS = 200_000

export type GuardLabel =
  | 'override' | 'persona' | 'ai-address' | 'concealment' | 'role-token' | 'role-marker' | 'fake-system'
  | 'tool-call' | 'exfil' | 'exfil-image' | 'exfil-link' | 'invisible-tags' | 'zero-width' | 'bidi'
  | 'hidden-instructions' | 'encoded-instructions' | 'base64-imperative'

/** Plain-text descriptions (model-visible warning, UI chip). */
export const GUARD_LABELS: Record<GuardLabel, string> = {
  'override': 'asks to ignore previous instructions',
  'persona': 'tries to change your role or rules',
  'ai-address': 'addresses an AI reading it',
  'concealment': 'asks to hide something from the user',
  'role-token': 'contains chat-template role tokens',
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
  'base64-imperative': 'a base64 blob next to instructions'
}

const WEIGHTS: Record<GuardLabel, number> = {
  'override': 4,
  'persona': 3,
  'ai-address': 4,
  'concealment': 4,
  'role-token': 8,
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
  'base64-imperative': 3
}

/** The only signals that flag on their own (ruling: near-zero false positives). */
export const FLAG_ALONE: ReadonlySet<GuardLabel> = new Set<GuardLabel>(['invisible-tags', 'role-token'])

export interface HeuristicResult {
  score: number
  labels: GuardLabel[]
  suspicious: boolean
  flagged: boolean
  /** Char offsets of EVERY match, in the ORIGINAL text (the LLM excerpt is cut around them). */
  hits: number[]
}

// ---- normalization -------------------------------------------------------------------------

/** Common Cyrillic / Greek lookalikes → Latin (fullwidth is NFKC's job). */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x',
  'ѕ': 's', 'і': 'i', 'ї': 'i', 'ј': 'j', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'ɡ': 'g',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
  'Ѕ': 'S', 'І': 'I', 'Ј': 'J',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X'
}

function isZeroWidth(cp: number): boolean {
  return cp === 0x00AD || (cp >= 0x200B && cp <= 0x200D) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xFEFF || cp === 0x180E || cp === 0x034F
}
function isBidi(cp: number): boolean {
  return (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200E || cp === 0x200F || cp === 0x061C
}
function isVariationSelector(cp: number): boolean {
  return (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)
}
const isTag = (cp: number) => cp >= 0xE0000 && cp <= 0xE007F

export interface Normalized {
  /** Whitespace (newlines too) collapsed to single spaces — what the instruction patterns read. */
  flat: string
  /** Same, but newlines kept (line-anchored patterns, code-context checks). */
  lined: string
  /** Original offset of each char of `flat` / `lined`. */
  flatMap: number[]
  linedMap: number[]
  /** Counts of what was stripped (the density labels). ZWJ is not counted: emoji are built with it. */
  zeroWidth: number
  bidiOverrides: number
  /** Unicode tag characters outside emoji flag sequences, and the ASCII they spell. */
  tags: number
  tagText: string
}

/** Emoji subdivision flags (🏴 + tag letters + CANCEL TAG) are honest uses of tag characters. */
const EMOJI_TAG_SEQ = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu

export function normalize(input: string): Normalized {
  const text = input.length > SCAN_MAX_CHARS ? input.slice(0, SCAN_MAX_CHARS) : input
  const emojiTagAt = new Set<number>()
  for (const m of text.matchAll(EMOJI_TAG_SEQ)) for (let i = m.index! + 2; i < m.index! + m[0].length; i++) emojiTagAt.add(i)
  let flat = ''
  let lined = ''
  const flatMap: number[] = []
  const linedMap: number[] = []
  let zeroWidth = 0
  let bidiOverrides = 0
  let tags = 0
  let tagText = ''
  let flatSpace = true
  let linedSpace = true
  let linedNl = true
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!
    const width = cp > 0xFFFF ? 2 : 1
    const at = i
    i += width
    if (isTag(cp)) {
      if (!emojiTagAt.has(at)) { tags++; if (cp >= 0xE0020 && cp <= 0xE007E) tagText += String.fromCharCode(cp - 0xE0000) }
      continue
    }
    if (isZeroWidth(cp)) { if (cp !== 0x200D) zeroWidth++; continue }
    if (isBidi(cp)) { if (cp !== 0x200E && cp !== 0x200F && cp !== 0x061C) bidiOverrides++; continue }
    if (isVariationSelector(cp)) continue
    // Markdown escapes (web_fetch's htmlToMarkdown writes `web\_fetch`, `<|im\_start|>`): the
    // backslash before ASCII punctuation is dropped, so escaped text matches like the plain text.
    if (cp === 0x5C && i < text.length && /[!-/:-@[-`{-~]/.test(text[i]!)) continue
    const raw = String.fromCodePoint(cp)
    const n = raw.normalize('NFKC')
    for (const ch of n) {
      const c = CONFUSABLES[ch] ?? ch
      if (/\s/.test(c)) {
        if (!flatSpace) { flat += ' '; flatMap.push(at); flatSpace = true }
        if (c === '\n' || c === '\r') {
          if (!linedNl) {
            if (linedSpace && lined.endsWith(' ')) { lined = lined.slice(0, -1); linedMap.pop() }
            lined += '\n'; linedMap.push(at); linedNl = true; linedSpace = true
          }
        } else if (!linedSpace) { lined += ' '; linedMap.push(at); linedSpace = true }
        continue
      }
      flat += c; flatMap.push(at); flatSpace = false
      lined += c; linedMap.push(at); linedSpace = false; linedNl = false
    }
  }
  return { flat, lined, flatMap, linedMap, zeroWidth, bidiOverrides, tags, tagText }
}

// ---- patterns (on normalized text) ---------------------------------------------------------

const OVERRIDE = [
  /\b(?:ignore|disregard|forget|override|bypass|discard)\b[^.]{0,40}?\b(?:previous|prior|above|earlier|preceding|original|existing|system|all)\b[^.]{0,25}?\b(?:instructions?|prompts?|rules|directions|directives|guidelines|commands)\b/gi,
  /\bnew (?:system )?instructions?\s*:/gi,
  // The same override in other languages (the LLM tier covers the rest for web and mail).
  /\bignora\s+(?:todas\s+)?las\s+instrucciones\s+(?:anteriores|previas)\b/gi,
  /\bignore[sz]?\s+(?:toutes\s+)?les\s+instructions\s+(?:pr[ée]c[ée]dentes|ant[ée]rieures)\b/gi,
  /\bignorier(?:e|en)?\s+(?:alle\s+)?(?:vorherigen|bisherigen|vorigen)\s+(?:Anweisungen|Instruktionen)\b/gi,
  /\bignora\s+(?:tutte\s+)?le\s+istruzioni\s+(?:precedenti|sopra|ricevute)\b/gi,
  /\bignore\s+(?:todas\s+)?as\s+instru[çc][õo]es\s+anteriores\b/gi,
  /忽略(?:之前|以上|上面|先前|前面|所有)(?:的)?(?:所有)?(?:指令|指示|说明|提示)/g,
  /(?:以前|前|上記)の(?:すべての)?指示を無視/g
]
const PERSONA = [
  /\byou are now\b/gi,
  /\bfrom now on,? (?:you|your)\b/gi,
  /\bdo anything now\b/gi,
  /\b(?:developer|jailbr(?:eak|oken)|god|unrestricted) mode\b/gi,
  /\byour (?:new )?(?:role|task|goal|instructions?) (?:is|are) now\b/gi
]
const AI_NOUN = '(?:ai|a\\.i\\.|llm|large language model|language model|ai assistant|assistant|ai agent|agent|chatbot|gpt|chatgpt|claude|bridget|copilot|gemini|model)s?'
const AI_ADDRESS = [
  new RegExp(`\\b(?:if you are|if you're|attention|note to|notice to|message (?:to|for)|instructions? (?:to|for)|dear|hey|hi|hello)[,:]?\\s+(?:an?\\s+|the\\s+|all\\s+|any\\s+)?${AI_NOUN}\\b`, 'gi'),
  new RegExp(`\\b${AI_NOUN}\\s+(?:reading|processing|summari[sz]ing|parsing|browsing|viewing|scanning|analy[sz]ing|helping)\\s+(?:this|these|the user|tony)\\b`, 'gi'),
  new RegExp(`\\bas (?:an?|the) ${AI_NOUN} (?:reading|processing|helping|working)\\b`, 'gi'),
  /\bwhen you (?:read|process|summari[sz]e|parse|see) this\b/gi
]
const CONCEALMENT = [
  /\b(?:do not|don't|never|without)\s+(?:tell(?:ing)?|inform(?:ing)?|mention(?:ing)?|reveal(?:ing)?|notify(?:ing)?|alert(?:ing)?|let(?:ting)?|show(?:ing)?|disclos(?:e|ing))\s+(?:this\s+(?:note\s+|message\s+)?(?:to\s+)?|it\s+(?:to\s+)?|anything\s+(?:to\s+)?)?(?:the\s+)?(?:user|tony|human|owner|operator)\b/gi,
  /\bkeep (?:this|it) (?:a )?secret from\b/gi,
  /\b(?:do not|don't|never)\s+(?:reveal|mention|disclose|acknowledge)\s+(?:this|these)\s+(?:note|instructions?|message)\b/gi
]
/** Chat-template special tokens: never in honest running text. */
const ROLE_TOKEN = /<\|(?:im_start|im_end|system|user|assistant|endoftext|start_header_id|end_header_id|eot_id|begin_of_text)\|>/g
const ROLE_MARKER = [
  /\[\/?INST\]/g,
  /<<\/?SYS>>/g
]
const ROLE_HEADING = /^\s*#{1,4}\s*(?:system|assistant)(?:\s+(?:message|prompt))?\s*:?\s*$/gim
const FAKE_SYSTEM = [
  /\b(?:SYSTEM|ADMIN|ADMINISTRATOR|DEVELOPER|OPERATOR)\s+(?:NOTICE|MESSAGE|OVERRIDE|INSTRUCTIONS?|UPDATE|ALERT|PROMPT)\b/g,
  /<\/?(?:system|system_prompt|instructions)>/gi,
  /\[\[?\s*(?:SYSTEM|ASSISTANT|ADMIN)\b[^\]]{0,30}\]\]?/g
]
const TOOL_NAMES = 'gmail_send|gmail_draft|gmail_modify|web_fetch|web_search|research_web|send_message|create_job|edit_job|run_job|schedule_wake|spawn_workstreams|steer_workstream|calendar_guest_event|calendar_write_event|calendar_rsvp|save_memory|forget_memory|delete_document|write_file|delete_files|export_to_document|create_skill|edit_skill'
const TOOL_CALL = [
  new RegExp(`\\b(?:call|use|run|invoke|execute|trigger)\\s+(?:the\\s+)?\`?(?:${TOOL_NAMES})\`?`, 'gi'),
  /\b(?:call|use|run|invoke)\s+the\s+`?(?:exec|bash)`?\s+tool\b/gi
]
const PRIVATE_DATA = '(?:e-?mails?|inbox|mailbox|messages|conversation|chat history|history|passwords?|credentials|api[ -]?keys?|tokens?|secrets?|ssh keys?|private keys?|\\.env|contacts|calendar|files|documents|memor(?:y|ies)|system prompt)'
const EXFIL = new RegExp(`\\b(?:send|forward|e-?mail|post|upload|exfiltrate|leak|transmit|append|include|encode|paste)\\b[^.]{0,60}?\\b(?:the user'?s?|tony'?s|his|her|their|the owner'?s|all(?: of)?(?: the)?|every|the last \\d+|the contents of(?: the)?)\\s+(?:\\w+\\s+){0,2}?${PRIVATE_DATA}\\b`, 'gi')
const NEGATION_BEFORE = /\b(?:never|not|n't|don't|do not|cannot|can't|won't)\b[^.]{0,25}$/i
/** A query value that IS a template placeholder (fix round 1, I1): `{CONVERSATION}`, `${SECRET}`,
 *  `[USER DATA]`, `<DATA>`, `INSERT_…`. Ordinary values — `\frac{a}{b}`, `{type:'bar'}`,
 *  `{id,name}`, `DATA_SUMMIT_2026`, `TOKEN=1`, `YOUR_API_KEY` in API docs — never match. */
const PLACEHOLDER_VALUE = /(?:^|[=&])(?:\{[A-Z][A-Z0-9_ ]{1,40}\}|\$\{?[A-Z][A-Z0-9_]{2,}\}?|\[[A-Z][A-Z0-9_ ]{2,40}\]|<[A-Z][A-Z0-9_ ]{2,40}>|INSERT_[A-Z0-9_]+)(?=&|$)/
const MD_IMAGE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)|<img\b[^>]*\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi
const MD_LINK = /(?<!!)\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)>?[^)]*\)/gi
/** An inline hiding style (the element's own text is what is hidden). */
const INLINE_HIDE = /<([a-z][a-z0-9]*)\b[^>]*\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.0+)?(?:px|pt|em|rem|%)?\b|opacity\s*:\s*0(?:\.0+)?\b|color\s*:\s*(?:#fff(?:fff)?|white|transparent)\b)[^"']*["'][^>]*>/gi
const COMMENT = /<!--([\s\S]{0,2000}?)-->/g
const BASE64 = /[A-Za-z0-9+/]{120,}={0,2}/g
const IMPERATIVE_NEAR = /\b(?:decode|follow|execute|run|eval|instructions?|obey)\b/i

// ---- scanning ------------------------------------------------------------------------------

function allHits(text: string, patterns: RegExp[], limit = 20): number[] {
  const out: number[] = []
  for (const p of patterns) {
    p.lastIndex = 0
    let m: RegExpExecArray | null
    let n = 0
    while ((m = p.exec(text)) && n++ < limit) { out.push(m.index); if (m[0].length === 0) p.lastIndex++ }
    p.lastIndex = 0
  }
  return out
}

/** The instruction categories present in a normalized flat string, with their offsets in it. */
function instructionLabels(flat: string): Array<[GuardLabel, number[]]> {
  const found: Array<[GuardLabel, number[]]> = []
  const add = (label: GuardLabel, at: number[]) => { if (at.length) found.push([label, at]) }
  add('override', allHits(flat, OVERRIDE))
  add('persona', allHits(flat, PERSONA))
  add('ai-address', allHits(flat, AI_ADDRESS))
  add('concealment', allHits(flat, CONCEALMENT))
  add('fake-system', allHits(flat, FAKE_SYSTEM))
  add('tool-call', allHits(flat, TOOL_CALL))
  add('exfil', exfilHits(flat))
  return found
}

function exfilHits(text: string): number[] {
  const out: number[] = []
  EXFIL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXFIL.exec(text)) && out.length < 20) {
    // "Never send your password by email" is advice, not an attempt.
    if (!NEGATION_BEFORE.test(text.slice(Math.max(0, m.index - 30), m.index))) out.push(m.index)
  }
  EXFIL.lastIndex = 0
  return out
}

function urlCarriesData(url: string): boolean {
  const q = url.indexOf('?')
  if (q < 0) return false
  const query = url.slice(q + 1)
  let decoded = query
  try { decoded = decodeURIComponent(query) } catch { /* keep the raw query */ }
  return query.split('&').some(p => PLACEHOLDER_VALUE.test(p.includes('=') ? `=${p.slice(p.indexOf('=') + 1)}` : p))
    || decoded.split('&').some(p => PLACEHOLDER_VALUE.test(p.includes('=') ? `=${p.slice(p.indexOf('=') + 1)}` : p))
}

function urlHits(text: string, re: RegExp): number[] {
  const out: number[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && out.length < 20) {
    const url = m[1] ?? m[2]
    if (url && urlCarriesData(url)) out.push(m.index)
  }
  re.lastIndex = 0
  return out
}

/** Hidden text that ASKS for something — addressing an AI ("Hello, Claude" in a hidden code tab) or
 *  a persona line alone is not enough (I2). */
function hiddenAsks(body: string): boolean {
  return instructionLabels(body.replace(/\s+/g, ' ')).some(([l]) => l !== 'ai-address' && l !== 'persona')
}

/** Hidden markup whose OWN text is instruction-shaped (fix round 1, I2): an inline-styled element's
 *  text up to its closing tag, or an HTML comment's body. A `<style>` block or a CSS file hides UI,
 *  not text, so a rule there never looks at what follows it. */
function hiddenInstructionHits(lined: string): number[] {
  const out: number[] = []
  INLINE_HIDE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_HIDE.exec(lined)) && out.length < 10) {
    const close = lined.indexOf(`</${m[1]}`, m.index + m[0].length)
    const body = lined.slice(m.index + m[0].length, close < 0 ? m.index + m[0].length + 600 : Math.min(close, m.index + m[0].length + 2000))
    if (hiddenAsks(body)) out.push(m.index)
  }
  INLINE_HIDE.lastIndex = 0
  COMMENT.lastIndex = 0
  while ((m = COMMENT.exec(lined)) && out.length < 10) {
    if (hiddenAsks(m[1]!)) out.push(m.index)
  }
  COMMENT.lastIndex = 0
  return out
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

/** Base64 blobs: decoded instructions, or a text blob beside imperative words. */
function base64Labels(flat: string): Array<[GuardLabel, number[]]> {
  BASE64.lastIndex = 0
  let m: RegExpExecArray | null
  let n = 0
  let near = -1
  const encoded: number[] = []
  while ((m = BASE64.exec(flat)) && n++ < 8) {
    let decoded = ''
    try { decoded = Buffer.from(m[0].slice(0, 8000), 'base64').toString('latin1') } catch { continue }
    if (!looksLikeText(decoded)) continue
    if (instructionLabels(normalize(decoded).flat).length) { encoded.push(m.index); continue }
    const around = flat.slice(Math.max(0, m.index - 200), m.index) + flat.slice(m.index + m[0].length, m.index + m[0].length + 200)
    if (near < 0 && IMPERATIVE_NEAR.test(around)) near = m.index
  }
  BASE64.lastIndex = 0
  if (encoded.length) return [['encoded-instructions', encoded]]
  if (near >= 0) return [['base64-imperative', [near]]]
  return []
}

/** Is offset `i` of `lined` inside code — a ``` fence, an inline `code` span, or a quoted string on
 *  its line? (Docs and test data show role tokens there; an injection needs them in running text.) */
function inCode(lined: string, i: number): boolean {
  const before = lined.slice(0, i)
  if (((before.match(/```/g) ?? []).length % 2) === 1) return true
  const lineStart = before.lastIndexOf('\n') + 1
  const lineBefore = before.slice(lineStart)
  if (((lineBefore.match(/`/g) ?? []).length % 2) === 1) return true
  if (((lineBefore.match(/"/g) ?? []).length % 2) === 1) return true
  if (((lineBefore.match(/(?<![a-z])'|'(?![a-z])/gi) ?? []).length % 2) === 1) return true
  return false
}

/** Score `text` (pure). */
export function scoreText(input: string): HeuristicResult {
  const n = normalize(input)
  const labels = new Map<GuardLabel, number[]>()
  const add = (label: GuardLabel, at: number[], map: number[]) => {
    if (!at.length) return
    labels.set(label, [...(labels.get(label) ?? []), ...at.map(i => map[Math.min(i, map.length - 1)] ?? 0)])
  }
  for (const [l, at] of instructionLabels(n.flat)) add(l, at, n.flatMap)

  // Role tokens flag alone — in running text. Inside code or a quoted string they only route.
  const tokens = allHits(n.lined, [ROLE_TOKEN])
  const running = tokens.filter(i => !inCode(n.lined, i))
  add('role-token', running, n.linedMap)
  add('role-marker', [...tokens.filter(i => inCode(n.lined, i)), ...allHits(n.lined, ROLE_MARKER), ...allHits(n.lined, [ROLE_HEADING])], n.linedMap)

  add('exfil-image', urlHits(n.lined, MD_IMAGE), n.linedMap)
  add('exfil-link', urlHits(n.lined, MD_LINK), n.linedMap)
  add('hidden-instructions', hiddenInstructionHits(n.lined), n.linedMap)
  for (const [l, at] of base64Labels(n.flat)) add(l, at, n.flatMap)

  if (n.tags >= 2) {
    labels.set('invisible-tags', [0])
    // What the tags spell is scanned too (its categories add to the score).
    for (const [l] of instructionLabels(normalize(n.tagText).flat)) if (!labels.has(l)) labels.set(l, [0])
  }
  if (n.zeroWidth >= 16) labels.set('zero-width', [0])
  if (n.bidiOverrides >= 6) labels.set('bidi', [0])

  const list = [...labels.keys()]
  const score = list.reduce((s, l) => s + WEIGHTS[l], 0)
  const hits = [...new Set([...labels.values()].flat())].sort((a, b) => a - b)
  return { score, labels: list, suspicious: score >= SUSPICIOUS_SCORE, flagged: list.some(l => FLAG_ALONE.has(l)), hits }
}

/** Notes our own tools attach to untrusted results — never scanned (they say "instructions"). */
export function stripOwnNotes(text: string, notes: readonly string[]): string {
  let t = text
  for (const note of notes) if (note) t = t.split(note).join(' ')
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
