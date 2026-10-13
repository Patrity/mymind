// Cycle 85 fix round 1 (I3): when `pnpm eval --local` may run a suite IN the CLI process.
//
// --local bypasses the worker: its drain, its boot orphan handling and — the important one — its ONE
// process-wide eval pool (lib/eval/pool.ts). A second process has a second "half" of each model's
// pool, so a --local run beside a worker running evals could take a model's whole pool. It is
// therefore a dev convenience only, refused unless ALL hold:
//   - not production (NODE_ENV) and not the exclusive prod worker env (AGENT_RUNTIME_EXCLUSIVE);
//   - the database is a local one: localhost / 127.0.0.1 / ::1 / a unix socket, or a host listed in
//     MYMIND_EVAL_LOCAL_HOSTS (comma-separated) — never a remote / prod DB by accident;
//   - no worker is online in this bus namespace (it would run evals with its own pool beside this one —
//     use it instead: drop --local);
//   - the caller passed --i-know (it runs real model calls and sandboxes from this terminal).
// The CLI uses core's evalPool, the same pool the worker uses — in one process at a time.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The database host of a postgres URL ('' for a unix socket / unparseable). */
export function databaseHost(url: string | undefined): string | null {
  if (!url) return null
  // A unix socket (`?host=/dir`) — the URL may have no host part at all, which URL() rejects.
  if (/[?&]host=(%2F|\/)/i.test(url)) return ''
  try {
    const u = new URL(url)
    const sock = u.searchParams.get('host')
    if (sock?.startsWith('/')) return ''
    return (u.hostname || sock || '').toLowerCase()
  } catch { return null }
}

export function localRunRefusal(i: {
  env: NodeJS.ProcessEnv
  databaseUrl: string | undefined
  iKnow: boolean
  workerOnline: boolean
}): string | null {
  if (i.env.NODE_ENV === 'production') return '--local is refused in production (NODE_ENV=production) — enqueue to the worker instead (drop --local)'
  if (i.env.AGENT_RUNTIME_EXCLUSIVE) return '--local is refused where AGENT_RUNTIME_EXCLUSIVE is set (the production worker env) — drop --local'
  const host = databaseHost(i.databaseUrl)
  if (host === null) return '--local needs a parseable DATABASE_URL'
  const extra = (i.env.MYMIND_EVAL_LOCAL_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
  if (host !== '' && !LOCAL_HOSTS.has(host) && !extra.includes(host)) return `--local is refused against a non-local database (${host}); list a dev host in MYMIND_EVAL_LOCAL_HOSTS to allow it`
  if (i.workerOnline) return 'a worker is online in this bus namespace — it runs evals with the shared eval pool; drop --local'
  if (!i.iKnow) return '--local runs real model calls and sandboxes in this process; add --i-know to confirm'
  return null
}
