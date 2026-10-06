import { GOOGLE_SCOPES } from '../../../shared/utils/google-scopes'
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
