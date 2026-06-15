export default defineEventHandler(async (event) => {
  const script = await useStorage('assets:setup').getItem('cc-hook.sh')
  if (typeof script !== 'string') {
    throw createError({ statusCode: 500, statusMessage: 'cc-hook.sh asset missing' })
  }
  setResponseHeader(event, 'content-type', 'text/x-shellscript; charset=utf-8')
  setResponseHeader(event, 'content-disposition', 'inline; filename="cc-hook.sh"')
  return script
})
