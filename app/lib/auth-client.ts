import { createAuthClient } from 'better-auth/vue'

// Singleton better-auth Vue client.
// baseURL defaults to the current origin so no config needed for local dev or prod.
// The Vue client exposes reactive useSession() and signIn.email / signOut actions.
export const authClient = createAuthClient()
