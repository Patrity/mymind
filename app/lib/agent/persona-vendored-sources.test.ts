// Guards the three MyMind patches in the vendored `ai-elements/persona/Persona.vue` that are
// otherwise lost SILENTLY when someone re-copies that component from ai-elements-vue: typecheck,
// the suite and the production build all stay green, the page still renders, and the only symptom
// is that Rive's wasm quietly reverts to jsdelivr and the `.riv` files to a Vercel blob bucket we
// do not own — reopening the spec's risk #2 (a third-party asset host going away takes /agent's
// core visual with it) with nothing to notice it until that host is down.
//
// The other six vendored patches already self-detect: the `prompt-input/context.ts` re-entrancy
// guard is pinned by prompt-input-submit.test.ts (which imports the vendored provider directly),
// and the five `context/*` tokenlens removals break the build loudly because `tokenlens` is in
// neither package.json nor the lockfile. These three had no net at all.
//
// This reads the component as TEXT rather than importing it. Two reasons, both deliberate:
//   1. vitest here has no @vitejs/plugin-vue registered, so importing a `.vue` SFC fails in the
//      transform (verified: "Failed to parse source for import analysis" on the <script> block).
//   2. Even with a plugin it would not help — `sources` is a module-local const inside
//      <script setup>, never exported. Extracting it to a sibling .ts module to make it
//      importable would actively DEFEAT this test: a re-copy would restore an inline map in
//      Persona.vue and leave the extracted module orphaned, and the test would still pass while
//      the app fetched from the CDN again. The failure mode is "this file got overwritten", so
//      the assertion has to be about this file.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PERSONA_VARIANTS } from './persona'

const PERSONA_VUE = fileURLToPath(new URL('../../components/ai-elements/persona/Persona.vue', import.meta.url))
const src = readFileSync(PERSONA_VUE, 'utf8')

/** variant -> the `.riv` URL its `sources` entry points at. */
function parseSources(text: string): Record<string, string> {
  const block = /const sources = \{([\s\S]*?)\n\} as const/.exec(text)
    ?? /const sources = \{([\s\S]*?)\n\}/.exec(text)
  if (!block) throw new Error('could not find the `sources` map in Persona.vue — the vendored component was restructured')
  const out: Record<string, string> = {}
  // `source:` is sometimes wrapped onto the next line by the upstream formatter.
  const entry = /(\w+):\s*\{[^{}]*?source:\s*\n?\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = entry.exec(block[1]!)) !== null) out[m[1]!] = m[2]!
  return out
}

const sources = parseSources(src)

describe('vendored Persona.vue — the patches a re-copy would silently drop', () => {
  it('parses a sources entry for every variant the picker offers', () => {
    // Sanity on the parser itself: if this regex ever silently matched nothing, every
    // assertion below would vacuously pass.
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(PERSONA_VARIANTS.length)
    for (const v of PERSONA_VARIANTS) expect(sources, `no sources entry for picker variant '${v}'`).toHaveProperty(v)
  })

  it('every picker-reachable variant loads its .riv from OUR origin', () => {
    // Driven by PERSONA_VARIANTS, not a hardcoded list — so this also fails if someone
    // re-enables a variant in the picker without vendoring its .riv alongside.
    for (const v of PERSONA_VARIANTS) {
      expect(sources[v], `variant '${v}'`).toMatch(/^\/persona-riv\/[\w.-]+\.riv$/)
    }
  })

  it('no picker-reachable variant points at an external host', () => {
    for (const v of PERSONA_VARIANTS) {
      expect(sources[v], `variant '${v}' must not be fetched from a third-party host`).not.toMatch(/^https?:\/\//)
    }
  })

  it('the retired variants are the ONLY ones still on the upstream bucket', () => {
    // halo/command keep their upstream URLs deliberately (both render white-on-white and are
    // out of PERSONA_VARIANTS, so nothing can select them). Pinning that keeps this test honest
    // about what it does and does not cover.
    const external = Object.entries(sources).filter(([, url]) => /^https?:\/\//.test(url)).map(([v]) => v)
    expect(external.sort()).toEqual(['command', 'halo'])
    for (const v of external) expect(PERSONA_VARIANTS).not.toContain(v)
  })

  it('the directory is persona-riv, never a /rive* path', () => {
    // Nitro's publicAssets entry for the wasm uses baseURL 'rive' and PREFIX-matches, so
    // anything served from a /rive* path is routed into the @rive-app package dir and 404s.
    for (const v of PERSONA_VARIANTS) expect(sources[v]).not.toMatch(/^\/rive/)
  })

  it('Rive is pointed at our own wasm before the first `new Rive`', () => {
    expect(src).toContain("RuntimeLoader.setWasmUrl('/rive/rive.wasm')")
    expect(src).toContain("RuntimeLoader.setWasmFallbackUrl('/rive/rive_fallback.wasm')")
    // ...and at MODULE scope, not inside a lifecycle hook: the runtime resolves its wasm URL
    // once, so a `setWasmUrl` that runs after the component mounts is already too late. Anchored
    // on `withDefaults(` (the first thing after the patch, and the only occurrence in the file)
    // rather than on `new Rive(` — the patch's own comment contains that string, so indexOf
    // would match the comment and the assertion would pass for the wrong reason.
    expect(src.indexOf('setWasmUrl')).toBeLessThan(src.indexOf('withDefaults('))
  })

  it('keeps the srcOverride prop the dev fixture proves loadError with', () => {
    expect(src).toContain('srcOverride')
  })
})
