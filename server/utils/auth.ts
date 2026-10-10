// The better-auth factory lives in server/lib/auth (cycle 80: it moves into @mymind/core). This
// re-export keeps Nitro's auto-imported `useAuth()` and the explicit `../utils/auth` imports in
// routes/middleware working unchanged.
export { useAuth } from '../lib/auth'
