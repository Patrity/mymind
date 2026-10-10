import { APIError, createAuthMiddleware } from 'better-auth/api'
import { GOOGLE_SCOPES } from '../../shared/utils/google-scopes'
import { googleRefreshAccessToken } from './refresh-probe'

/**
 * Cycle 79: Google is a LINKED account (Settings → Connections), never a sign-in / sign-up path.
 * better-auth 1.6.13 specifics (verified in node_modules):
 *  - `emailAndPassword.disableSignUp` is NOT consulted by the OAuth callback. The callback's
 *    sign-up gate is `provider.disableImplicitSignUp && !requestSignUp || provider.options.disableSignUp`
 *    — so `disableImplicitSignUp` alone is bypassable with `requestSignUp: true`; `disableSignUp`
 *    is the hard stop.
 *  - The ID-token sign-in path reads `provider.disableSignUp` (never set for google), so it would
 *    create users — `disableIdTokenSignIn` closes it.
 *  - Google adds openid/email/profile by default; `disableDefaultScope` keeps the URL to exactly
 *    GOOGLE_SCOPES (which already contains them).
 */
export function googleSocialProviders(clientId: string, clientSecret: string) {
  return {
    google: {
      clientId,
      clientSecret,
      accessType: 'offline' as const,
      prompt: 'consent' as const,
      scope: GOOGLE_SCOPES,
      disableDefaultScope: true,
      disableSignUp: true,
      disableImplicitSignUp: true,
      disableIdTokenSignIn: true,
      refreshAccessToken: googleRefreshAccessToken({ clientId, clientSecret })
    }
  }
}

/** Tokens at rest are encrypted (access/refresh only — better-auth stores idToken plaintext).
 *  Linking is explicit only (linkSocial from a session); a different Google email than the
 *  MyMind login is the whole point, hence allowDifferentEmails. */
export const GOOGLE_ACCOUNT_OPTIONS = {
  encryptOAuthTokens: true,
  accountLinking: {
    enabled: true,
    allowDifferentEmails: true,
    disableImplicitLinking: true
  }
}

/**
 * D1: Google is never a login method. Sign-UP is closed by the provider flags above, but an
 * already-LINKED Google account would still sign in through `/sign-in/social` (link-account.mjs's
 * `linkedAccount` branch issues a session). MyMind has no other social provider, so the endpoint is
 * refused outright. `/link-social` (session-required) and `/callback/:id` are untouched — the
 * callback is unreachable without state minted by one of the two, and only link-social remains.
 * (`/sign-in/oauth2` exists only in the generic-oauth plugin, which MyMind doesn't load.)
 */
export const GOOGLE_AUTH_HOOKS = {
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/sign-in/social') {
      throw new APIError('FORBIDDEN', { message: 'Social sign-in is disabled; link Google from Settings → Connections.' })
    }
  })
}

/**
 * A session holder must not be able to pull decrypted Google tokens over HTTP. better-auth 1.6.13
 * applies `disabledPaths` only in the HTTP router's onRequest (api/index.mjs) — in-process
 * `auth.api.getAccessToken(...)` (what googleToken uses) is unaffected.
 */
export const DISABLED_AUTH_PATHS = ['/get-access-token', '/refresh-token', '/account-info']
