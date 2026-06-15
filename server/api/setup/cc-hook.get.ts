export default defineEventHandler(async (event) => {
  // Nitro's server-asset storage returns the file as a string, Buffer, or
  // Uint8Array depending on driver/version — read the raw value and coerce to
  // a utf-8 string so the strict typeof guard can't 500 on a binary payload.
  // Primary: the custom serverAssets mount (baseName 'setup' → 'assets:setup').
  // Fallback: Nitro's default server-assets scan ('assets:server', key 'setup:cc-hook.sh')
  // — covers either mount being the populated one across Nitro versions.
  const read = async (base: string, key: string) => {
    const s = useStorage(base)
    return (await s.getItemRaw?.(key)) ?? (await s.getItem(key))
  }
  const raw = (await read('assets:setup', 'cc-hook.sh')) ?? (await read('assets:server', 'setup:cc-hook.sh'))
  if (raw == null) {
    throw createError({ statusCode: 500, statusMessage: 'cc-hook.sh asset missing' })
  }
  const script = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')
  setResponseHeader(event, 'content-type', 'text/x-shellscript; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'inline; filename="cc-hook.sh"')
  return script
})
