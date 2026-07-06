// server/lib/analytics/litellm.ts
// LiteLLM admin-API client for the request log. The master key is decrypted
// here and only ever placed in the outbound Authorization header.
import { decryptSecret } from '../ai/registry/crypto'
import type { AnalyticsConfig } from './types'
import type { RequestLogResponse, RequestLogRow } from '../../../shared/types/analytics'

const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const asStr = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export function normalizeSpendRow(raw: Record<string, unknown>): RequestLogRow {
  const meta = (raw.metadata ?? {}) as Record<string, unknown>
  const start = asStr(raw.startTime)
  const end = asStr(raw.endTime)
  const startMs = start ? Date.parse(start) : NaN
  const endMs = end ? Date.parse(end) : NaN

  let cacheHit: boolean | null = null
  if (typeof raw.cache_hit === 'boolean') cacheHit = raw.cache_hit
  else if (raw.cache_hit === 'True') cacheHit = true
  else if (raw.cache_hit === 'False') cacheHit = false

  let status: RequestLogRow['status'] = null
  if (meta.status === 'success' || meta.status === 'failure') status = meta.status
  else if (meta.error_information) status = 'failure'

  return {
    id: asStr(raw.request_id) ?? crypto.randomUUID(),
    startedAt: start ?? '',
    model: asStr(raw.model) ?? '?',
    promptTokens: asNum(raw.prompt_tokens),
    completionTokens: asNum(raw.completion_tokens),
    latencyMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null,
    spendUsd: asNum(raw.spend),
    keyAlias: asStr(meta.user_api_key_alias),
    cacheHit,
    status,
  }
}

export async function fetchSpendLogs(cfg: AnalyticsConfig, page: number, pageSize: number): Promise<RequestLogResponse> {
  if (!cfg.litellmMasterKeyEnc) throw createError({ statusCode: 409, statusMessage: 'litellm key not configured' })
  const headers = { authorization: `Bearer ${decryptSecret(cfg.litellmMasterKeyEnc)}` }

  try {
    // Primary: paginated admin-UI endpoint
    const res = await $fetch<{ data?: Record<string, unknown>[], total_pages?: number } | Record<string, unknown>[]>(
      `${cfg.litellmUrl}/spend/logs/ui`,
      { query: { page, page_size: pageSize }, headers, timeout: 5000 },
    )
    const rows = Array.isArray(res) ? res : (res.data ?? [])
    const totalPages = Array.isArray(res) ? null : (typeof res.total_pages === 'number' ? res.total_pages : null)
    return { rows: rows.map(normalizeSpendRow), page, pageSize, totalPages }
  } catch (err) {
    const status = (err as { statusCode?: number, response?: { status?: number } }).response?.status
    if (status !== 404) throw err
  }

  // Fallback for LiteLLM versions without /spend/logs/ui: last-24h window, slice server-side.
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 3600 * 1000)
  const all = await $fetch<Record<string, unknown>[]>(`${cfg.litellmUrl}/spend/logs`, {
    query: { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) },
    headers, timeout: 5000,
  })
  const sorted = [...all].sort((a, b) => String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')))
  const slice = sorted.slice((page - 1) * pageSize, page * pageSize)
  return { rows: slice.map(normalizeSpendRow), page, pageSize, totalPages: Math.max(1, Math.ceil(sorted.length / pageSize)) }
}
