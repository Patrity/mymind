export default defineEventHandler(async (event) => {
  // Mirrors cc-hook.get.ts. Serves the one-shot transcript recovery script so it can
  // be pulled onto every machine that runs Claude Code (macOS, Windows, WSL) without
  // a repo checkout — same asset-mount fallback dance as the hook installers.
  const read = async (base: string, key: string) => {
    const s = useStorage(base)
    return (await s.getItemRaw?.(key)) ?? (await s.getItem(key))
  }
  const raw = (await read('assets:setup', 'transcript-backfill.mjs'))
    ?? (await read('assets:server', 'setup:transcript-backfill.mjs'))
  if (raw == null) {
    throw createError({ statusCode: 500, statusMessage: 'transcript-backfill.mjs asset missing' })
  }
  const script = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')
  setResponseHeader(event, 'content-type', 'text/javascript; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'inline; filename="transcript-backfill.mjs"')
  return script
})
