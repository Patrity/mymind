import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'vue/compiler-sfc'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { CLIENT_COMMANDS, type CommandEntry } from '../shared/types/commands'
import { commandsOrFallback } from '../app/composables/useCommands'

describe('commandsOrFallback', () => {
  it('returns fetched commands when the request succeeded', () => {
    const fetched = [{ name: 'browser-testing', description: 'd', kind: 'skill' as const }]
    expect(commandsOrFallback(fetched, false)).toEqual(fetched)
  })

  it('falls back to the code-defined commands on error', () => {
    // A server error must never cost you /clear.
    expect(commandsOrFallback(undefined, true)).toEqual(CLIENT_COMMANDS)
  })

  it('falls back when the fetch returned nothing yet', () => {
    expect(commandsOrFallback(undefined, false)).toEqual(CLIENT_COMMANDS)
  })

  it('does not fall back for a legitimately empty list', () => {
    // An empty array means "no commands", which is different from "not loaded".
    expect(commandsOrFallback([], false)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The menu ROW MARKUP, rendered from the real PromptInput.vue template source.
//
// This cycle already shipped a `/` menu that rendered ZERO rows through two green code
// reviews, two fix rounds and a full green suite, because every test stopped at the data
// and nothing ever rendered the template. So these tests read the actual .vue file, pull
// its <template> out with vue's own SFC parser and SSR-render it: a row that stops being
// emitted fails here instead of in the browser.
//
// Child components are left unresolved on purpose (isCustomElement) — the command list is
// deliberately hand-rolled plain HTML (`<ul role="listbox">`), so nothing we assert on
// depends on the vendored wrappers being mounted.
// ---------------------------------------------------------------------------
const TEMPLATE = (() => {
  const src = readFileSync(new URL('../app/components/agent/PromptInput.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(src)
  if (!descriptor.template) throw new Error('PromptInput.vue has no <template>')
  return descriptor.template.content
})()

/**
 * `menuVisible` is passed but `menuOpen` deliberately is NOT: the `<ul>`'s `v-if` must read
 * the same single condition the keyboard handler gates on. If it drifts back to
 * `menuOpen && filteredCommands.length`, the list renders nothing and these go red.
 */
async function renderComposer(state: { menuVisible: boolean, filteredCommands: CommandEntry[] }) {
  const app = createSSRApp({
    template: TEMPLATE,
    data: () => ({
      ...state,
      highlightedIndex: 0,
      ATTACHMENT_ACCEPT: 'image/*',
      files: [],
      showPersona: false,
      state: {},
      connected: true,
      model: '',
      modelItems: [],
      speak: false,
      contextMeter: null,
      micOn: false,
      busy: false,
      canSubmit: true
    }),
    methods: {
      onPickCommand() {}, onComposerKeydown() {}, openFileDialog() {}, removeFile() {}, emit() {}
    }
  })
  app.config.warnHandler = () => {}
  app.config.compilerOptions.isCustomElement = () => true
  // SSR emits the template's own HTML comments (and Vue's `<!---->` v-if placeholders) into
  // the markup; strip them so an assertion never matches a code comment that merely mentions
  // the word it is looking for.
  const html = (await renderToString(app)).replace(/<!--[\s\S]*?-->/g, '')
  const start = html.indexOf('<ul')
  return { html, menu: start === -1 ? '' : html.slice(start, html.indexOf('</ul>') + 5) }
}

const entry = (over: Partial<CommandEntry> = {}): CommandEntry => ({
  name: 'browser-testing', description: 'Browser testing', kind: 'skill', ...over
})

describe('the / command menu row', () => {
  it('renders one row per command, with its name and description', async () => {
    const { menu } = await renderComposer({
      menuVisible: true,
      filteredCommands: [entry(), entry({ name: 'clear', description: 'Clear this conversation', kind: 'client' })]
    })
    expect(menu).toContain('role="listbox"')
    expect((menu.match(/role="option"/g) ?? []).length).toBe(2)
    expect(menu).toContain('/browser-testing')
    expect(menu).toContain('Browser testing')
    expect(menu).toContain('/clear')
  })

  it('does NOT render the hint — a row is a name and one line of description', async () => {
    // The "Use when …" hint made every row wrap to two or three lines and buried the names
    // the menu exists to let you scan. Name + truncated description only.
    const { menu } = await renderComposer({ menuVisible: true, filteredCommands: [entry({ hint: 'when to use it' })] })
    expect(menu).not.toContain('when to use it')
    expect(menu).toContain('Browser testing')
  })

  it('floats over the transcript instead of growing the composer', async () => {
    // In the flow the list pushed the input block down and shoved the conversation up on
    // every keystroke, which read as the composer breaking rather than a menu opening.
    // The positioning lives on the wrapper AROUND the <ul>, so assert on the full html and
    // require it to sit immediately before the list rather than anywhere on the page.
    const { html } = await renderComposer({ menuVisible: true, filteredCommands: [entry()] })
    const wrapper = html.slice(0, html.indexOf('<ul'))
    const lastDiv = wrapper.lastIndexOf('<div')
    expect(lastDiv).toBeGreaterThan(-1)
    const openTag = wrapper.slice(lastDiv)
    expect(openTag).toContain('absolute')
    expect(openTag).toContain('bottom-full')
  })

  it('renders a shadows marker naming the source the winner displaced', async () => {
    // Spec §2.1 / Risk #4: a skill that silently stopped being reachable must be
    // explainable from the UI. The merge has always computed `shadows`; nothing showed it.
    const { menu } = await renderComposer({
      menuVisible: true,
      filteredCommands: [entry({ name: 'clear', kind: 'client', description: 'Clear this conversation', shadows: ['skill'] })]
    })
    expect(menu).toContain('shadows')
    expect(menu).toContain('skill')
  })

  it('lists every displaced source when more than one lost', async () => {
    const { menu } = await renderComposer({
      menuVisible: true,
      filteredCommands: [entry({ name: 'clear', kind: 'client', description: 'C', shadows: ['prompt', 'skill'] })]
    })
    expect(menu).toMatch(/shadows\s*prompt, skill/)
  })

  it('renders NO shadows marker for an entry that displaced nothing', async () => {
    const { menu } = await renderComposer({ menuVisible: true, filteredCommands: [entry()] })
    expect(menu).not.toContain('shadows')
  })

  it('renders no list at all when the menu is not visible', async () => {
    const { menu } = await renderComposer({ menuVisible: false, filteredCommands: [entry()] })
    expect(menu).toBe('')
  })
})
