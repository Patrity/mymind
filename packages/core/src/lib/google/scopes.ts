import { coreConfig } from '../../config'

export { GOOGLE_SCOPES } from '../../shared/utils/google-scopes'

/** Google linking is available only when both OAuth client values are set
 *  (NUXT_GOOGLE_CLIENT_ID / NUXT_GOOGLE_CLIENT_SECRET). Unset ⇒ no provider at all. */
export function googleConfigured(): boolean {
  const cfg = coreConfig()
  return Boolean(cfg.googleClientId) && Boolean(cfg.googleClientSecret)
}
