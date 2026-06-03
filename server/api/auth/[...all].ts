export default defineEventHandler((event) => {
  return useAuth().handler(toWebRequest(event))
})
