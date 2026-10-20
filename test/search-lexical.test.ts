import { describe, it, expect, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import { isIdentifierLike, ftsMatch, ftsRank, runLexicalLane } from '@mymind/core/lib/search/lexical'

const dialect = new PgDialect()
const render = (q: SQL) => dialect.sqlToQuery(q)
const tsv = sql.raw('"memories"."tsv"')

describe('isIdentifierLike', () => {
  it('is false for ordinary natural-language queries', () => {
    expect(isIdentifierLike('how did we fix the plex transcoder deadlock')).toBe(false)
    expect(isIdentifierLike('TrueNAS pool expansion')).toBe(false)
    expect(isIdentifierLike('Qwen3-VL OOM')).toBe(false) // a hyphen is not an identifier marker
  })
  it('is true when the query carries path / namespace / snake_case / dotted markers', () => {
    expect(isIdentifierLike('server/services/search.ts')).toBe(true)
    expect(isIdentifierLike('hnsw.ef_search')).toBe(true)
    expect(isIdentifierLike('rerank_text_max')).toBe(true)
    expect(isIdentifierLike('192.168.2.25:8009')).toBe(true)
    expect(isIdentifierLike('litellm:spend')).toBe(true)
  })
  it('is true for hex / uuid-looking tokens', () => {
    expect(isIdentifierLike('a654ffc9')).toBe(true)
    expect(isIdentifierLike('sha256 6ac921528d61')).toBe(true)
    expect(isIdentifierLike('ff2ca2e1-1234-4abc-9def-0123456789ab')).toBe(true)
  })
  it('ignores sentence punctuation at the end of a natural-language query', () => {
    expect(isIdentifierLike('how did we fix the plex transcoder deadlock.')).toBe(false)
    expect(isIdentifierLike('is the rig up?')).toBe(false)
    expect(isIdentifierLike('what happened to TrueNAS...')).toBe(false)
  })
  it('is false for short all-alpha or all-digit words that merely happen to be hex-ish', () => {
    expect(isIdentifierLike('deadbeef is a word')).toBe(false) // 8 alpha-only chars: a real word, not a hash
    expect(isIdentifierLike('2026')).toBe(false)
    expect(isIdentifierLike('cafe bed')).toBe(false)
  })
})

describe('ftsMatch / ftsRank', () => {
  it('ftsMatch renders `tsv @@ websearch_to_tsquery(\'english\', $1)` with the query bound, not inlined', () => {
    const { sql: s, params } = render(ftsMatch(tsv, 'plex deadlock'))
    expect(s).toBe('"memories"."tsv" @@ websearch_to_tsquery(\'english\', $1)')
    expect(params).toEqual(['plex deadlock'])
  })
  it('ftsRank orders by ts_rank_cd desc against the same tsquery', () => {
    const { sql: s, params } = render(ftsRank(tsv, 'plex deadlock'))
    expect(s).toBe('ts_rank_cd("memories"."tsv", websearch_to_tsquery(\'english\', $1)) desc')
    expect(params).toEqual(['plex deadlock'])
  })
})

describe('runLexicalLane', () => {
  const ids = (...x: string[]) => x
  it('uses the FTS lane for a natural-language query and never calls the fallback when it hits', async () => {
    const fts = vi.fn(async () => ids('a', 'b'))
    const fallback = vi.fn(async () => ids('z'))
    const r = await runLexicalLane({ q: 'plex transcoder deadlock', enabled: true, fts, fallback })
    expect(r).toEqual({ ids: ['a', 'b'], mode: 'fts' })
    expect(fallback).not.toHaveBeenCalled()
  })
  it('falls back to the ILIKE lane when the tsquery yields zero rows', async () => {
    const fts = vi.fn(async () => ids())
    const fallback = vi.fn(async () => ids('z'))
    const r = await runLexicalLane({ q: 'plex transcoder deadlock', enabled: true, fts, fallback })
    expect(r).toEqual({ ids: ['z'], mode: 'ilike' })
    expect(fts).toHaveBeenCalledTimes(1)
  })
  it('goes straight to the ILIKE lane for an identifier-like query (FTS would stem/split it)', async () => {
    const fts = vi.fn(async () => ids('a'))
    const fallback = vi.fn(async () => ids('z'))
    const r = await runLexicalLane({ q: 'server/services/search.ts', enabled: true, fts, fallback })
    expect(r).toEqual({ ids: ['z'], mode: 'ilike' })
    expect(fts).not.toHaveBeenCalled()
  })
  it('honours the kill switch: enabled=false means the old ILIKE lane only', async () => {
    const fts = vi.fn(async () => ids('a'))
    const fallback = vi.fn(async () => ids('z'))
    const r = await runLexicalLane({ q: 'plex transcoder deadlock', enabled: false, fts, fallback })
    expect(r).toEqual({ ids: ['z'], mode: 'ilike' })
    expect(fts).not.toHaveBeenCalled()
  })
  it('falls back to ILIKE if the FTS query throws (e.g. tsv column missing before the migration ran)', async () => {
    const fts = vi.fn(async () => {
      throw new Error('column "tsv" does not exist')
    })
    const fallback = vi.fn(async () => ids('z'))
    const r = await runLexicalLane({ q: 'plex transcoder deadlock', enabled: true, fts, fallback })
    expect(r).toEqual({ ids: ['z'], mode: 'ilike' })
  })
})
