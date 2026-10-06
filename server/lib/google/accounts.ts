// server/lib/google/accounts.ts
// Resolves a tool's `account` argument (an optional label/email) to one or more connections,
// and fans a per-connection call out across however many connections are in play — skipping
// any that need reconnecting (by status, or discovered mid-flight via GoogleReconnectError)
// with a warning instead of failing the whole request.

import { listConnections, type Connection } from './connections'
import { GoogleReconnectError } from './token'

export type ResolveAccountsResult =
  | { ok: true; connections: Connection[] }
  | { ok: false; error: string }

function needsReconnectWarning(label: string): string {
  return `${label}: needs reconnecting in Settings → Connections`
}

/**
 * `account` is an optional label or email naming which connection to use.
 * - No connections at all → always an error.
 * - `write: true` requires a named account (a write must target exactly one mailbox/calendar).
 * - A named account that matches no label/email → an error listing the known labels.
 * - No named account on a read → every connection (ok AND needs_reconnect); `fanOut` is what
 *   skips the needs_reconnect ones, with a warning, when it actually runs them.
 */
export async function resolveAccounts(account: string | undefined, opts: { write: boolean }): Promise<ResolveAccountsResult> {
  const all = await listConnections()
  if (all.length === 0) {
    return { ok: false, error: 'no Google account connected — connect one in Settings → Connections' }
  }

  const labelList = all.map(c => c.label).join(', ')

  if (!account) {
    if (opts.write) {
      return { ok: false, error: `name an account: ${labelList}` }
    }
    return { ok: true, connections: all }
  }

  const needle = account.toLowerCase()
  const match = all.find(c => c.label.toLowerCase() === needle) ?? all.find(c => c.email.toLowerCase() === needle)
  if (!match) {
    return { ok: false, error: `unknown account "${account}" — name one of: ${labelList}` }
  }
  return { ok: true, connections: [match] }
}

/**
 * Runs `fn` against every 'ok' connection in parallel; a connection already marked
 * needs_reconnect is skipped (never called) with a warning, and a connection whose `fn` call
 * throws GoogleReconnectError mid-flight (discovered right now, by the client) is downgraded to
 * the same warning rather than failing every other account's results. Any other per-connection
 * failure is also reported as a warning so one bad account can't blank out the rest.
 */
export async function fanOut<T>(
  conns: Connection[],
  fn: (c: Connection) => Promise<T[]>
): Promise<{ items: (T & { account: string })[]; warnings: string[] }> {
  const items: (T & { account: string })[] = []
  const warnings: string[] = []

  const runnable: Connection[] = []
  for (const c of conns) {
    if (c.status === 'ok') {
      runnable.push(c)
    } else {
      warnings.push(needsReconnectWarning(c.label))
    }
  }

  const results = await Promise.allSettled(runnable.map(c => fn(c)))
  results.forEach((result, i) => {
    const c = runnable[i]!
    if (result.status === 'fulfilled') {
      for (const item of result.value) {
        items.push({ ...item, account: c.label })
      }
    } else if (result.reason instanceof GoogleReconnectError) {
      warnings.push(needsReconnectWarning(c.label))
    } else {
      const reason = result.reason
      warnings.push(`${c.label}: ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  })

  return { items, warnings }
}
