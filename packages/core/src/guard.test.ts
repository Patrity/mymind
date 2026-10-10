// Cycle 80 guard: @mymind/core must stay runnable outside Nuxt/Nitro (the step-2 worker).
// Fails on (a) a call to a Nitro/H3 runtime global — useRuntimeConfig, useNitroApp,
// defineEventHandler, useStorage, createError, defineNitroPlugin — or an unimported `$fetch`
// call, and (b) any import that resolves outside packages/core/src other than an npm package
// (Nuxt aliases, relative escapes, and Nuxt/Nitro runtime modules count as escapes).
// Parsed with the TypeScript AST, so comments and string literals never trip it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = dirname(fileURLToPath(import.meta.url))

const NITRO_GLOBALS = new Set(['useRuntimeConfig', 'useNitroApp', 'defineEventHandler', 'useStorage', 'createError', 'defineNitroPlugin'])
const RUNTIME_MODULES = [/^#/, /^h3$/, /^nitropack(\/|$)/, /^nitro(\/|$)/, /^nuxt(\/|$)/, /^@nuxt\//]

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : tsFiles(p)
    return n.endsWith('.ts') ? [p] : []
  })
}

/** Every violation in one source file; `file` is absolute (used to resolve relative imports). */
export function violations(file: string, src: string): string[] {
  const out: string[] = []
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const imported = new Set<string>()
  const where = (n: ts.Node) => `${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`

  const checkSpec = (spec: string, n: ts.Node) => {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec)
      if (target !== SRC && !target.startsWith(SRC + sep)) out.push(`${where(n)} import escapes packages/core/src: '${spec}'`)
    } else if (/^(~~|~|@@|@)\//.test(spec)) {
      out.push(`${where(n)} Nuxt alias import: '${spec}'`)
    } else if (RUNTIME_MODULES.some(re => re.test(spec))) {
      out.push(`${where(n)} Nuxt/Nitro runtime import: '${spec}'`)
    }
  }

  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpec(n.moduleSpecifier.text, n)
      if (ts.isImportDeclaration(n)) {
        const c = n.importClause
        if (c?.name) imported.add(c.name.text)
        const b = c?.namedBindings
        if (b && ts.isNamedImports(b)) for (const e of b.elements) imported.add(e.name.text)
        if (b && ts.isNamespaceImport(b)) imported.add(b.name.text)
      }
    }
    if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      checkSpec(n.argument.literal.text, n)
    }
    if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        checkSpec(n.arguments[0].text, n)
      }
      // vi.mock('…') / vi.importActual('…') name modules too.
      const callee = n.expression
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi'
        && /^(mock|doMock|unmock|doUnmock|importActual|importMock)$/.test(callee.name.text)
        && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        checkSpec(n.arguments[0].text, n)
      }
      if (ts.isIdentifier(callee) && NITRO_GLOBALS.has(callee.text)) out.push(`${where(n)} Nitro global call: ${callee.text}()`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // `$fetch` is fine when imported (e.g. `import { $fetch } from 'ofetch'`), not as Nitro's global.
  if (!imported.has('$fetch')) {
    const findFetch = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const c = n.expression
        const base = ts.isPropertyAccessExpression(c) ? c.expression : c
        if (ts.isIdentifier(base) && base.text === '$fetch') out.push(`${where(n)} unimported $fetch call`)
      }
      ts.forEachChild(n, findFetch)
    }
    findFetch(sf)
  }
  return out
}

describe('@mymind/core guard', () => {
  it('no Nitro runtime globals or escaping imports anywhere under packages/core/src', () => {
    const files = tsFiles(SRC)
    expect(files.length).toBeGreaterThan(300)
    const found = files.flatMap(f => violations(f, readFileSync(f, 'utf8')))
    expect(found).toEqual([])
  })

  // The detector itself: each rule fires on a minimal snippet, and comments/strings never do.
  const fake = join(SRC, 'lib', 'x', 'probe.ts')
  it.each([
    ['useRuntimeConfig', 'const c = useRuntimeConfig()'],
    ['useNitroApp', 'useNitroApp().hooks'],
    ['defineEventHandler', 'export default defineEventHandler(() => 1)'],
    ['useStorage', 'useStorage("x")'],
    ['createError', 'throw createError({ statusCode: 400 })'],
    ['defineNitroPlugin', 'export default defineNitroPlugin(() => {})'],
    ['$fetch', 'await $fetch<string>("https://x")'],
    ['$fetch.raw', 'await $fetch.raw("https://x")'],
    ['relative escape', 'import { x } from "../../../../server/utils/auth-guard"'],
    ['Nuxt alias', 'import { x } from "~~/server/utils/auth-guard"'],
    ['h3', 'import type { H3Event } from "h3"'],
    ['#imports', 'import { useRuntimeConfig } from "#imports"'],
    ['dynamic escape', 'await import("../../../../app/utils/x")'],
    ['vi.mock escape', 'vi.mock("../../../../test/helpers", () => ({}))']
  ])('flags %s', (_name, snippet) => {
    expect(violations(fake, snippet)).toHaveLength(1)
  })

  it('ignores comments, strings, imported $fetch, in-tree relatives and npm packages', () => {
    const ok = [
      '// useRuntimeConfig() used to live here',
      'const s = "createError(" + \'$fetch(\'',
      'import { $fetch } from "ofetch"; await $fetch("https://x")',
      'import { useDb } from "../../db"',
      'import { sql } from "drizzle-orm"',
      'vi.stubGlobal("useRuntimeConfig", () => ({}))'
    ].join('\n')
    expect(violations(fake, ok)).toEqual([])
  })
})
