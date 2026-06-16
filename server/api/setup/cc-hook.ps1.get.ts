export default defineEventHandler(async (event) => {
  // Mirrors cc-hook.get.ts (the bash installer) but serves the PowerShell port.
  // Primary mount: serverAssets baseName 'setup' → 'assets:setup'. Fallback: Nitro's
  // default server-assets scan ('assets:server', key 'setup:cc-hook.ps1').
  const read = async (base: string, key: string) => {
    const s = useStorage(base)
    return (await s.getItemRaw?.(key)) ?? (await s.getItem(key))
  }
  const raw = (await read('assets:setup', 'cc-hook.ps1')) ?? (await read('assets:server', 'setup:cc-hook.ps1'))
  if (raw == null) {
    throw createError({ statusCode: 500, statusMessage: 'cc-hook.ps1 asset missing' })
  }
  const script = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'inline; filename="cc-hook.ps1"')
  return script
})
