// Drives a REAL better-auth 1.6.13 instance (memory adapter, no DB, no network) with the exact
// Google provider + account options auth.ts uses, to pin two security properties:
//  1. Linking Google can never become a sign-UP path: an OAuth callback for an unknown Google
//     user creates no user, even when the attacker passes requestSignUp:true (which bypasses
//     disableImplicitSignUp on its own) — and the ID-token sign-in path is closed outright.
//  2. encryptOAuthTokens: true does not break email/password login (credential accounts carry
//     no OAuth tokens).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { googleSocialProviders, GOOGLE_ACCOUNT_OPTIONS } from './auth-options'
import { GOOGLE_SCOPES } from './scopes'

const BASE = 'http://localhost:3000'

type HookCall = { kind: 'create' | 'update', row: Record<string, unknown> | null }

function makeAuth(opts: { emailSignUp?: boolean, googleOverrides?: Record<string, unknown>, hookCalls?: HookCall[] } = {}) {
  const providers = googleSocialProviders('cid.apps.googleusercontent.com', 'csecret')
  type Row = Record<string, unknown>
  const db: { user: Row[], session: Row[], account: Row[], verification: Row[] } = { user: [], session: [], account: [], verification: [] }
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: 'test-secret-test-secret-test-secret-0123',
    baseURL: BASE,
    trustedOrigins: [BASE],
    emailAndPassword: { enabled: true, disableSignUp: !opts.emailSignUp },
    socialProviders: { google: { ...providers.google, ...opts.googleOverrides } },
    account: GOOGLE_ACCOUNT_OPTIONS,
    databaseHooks: opts.hookCalls
      ? { account: {
          create: { after: async (row) => { opts.hookCalls!.push({ kind: 'create', row: { ...row } }) } },
          update: { after: async (row) => { opts.hookCalls!.push({ kind: 'update', row: row ? { ...row } : null }) } }
        } }
      : undefined
  })
  return { auth, db }
}

function unsignedJwt(payload: Record<string, unknown>) {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`
}

afterEach(() => vi.unstubAllGlobals())

describe('google provider config', () => {
  it('requests offline access, forced consent, and exactly GOOGLE_SCOPES (no duplicated defaults)', async () => {
    const { auth } = makeAuth()
    const res = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' })
    }))
    const { url } = await res.json() as { url: string }
    const u = new URL(url)
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('prompt')).toBe('consent')
    expect(u.searchParams.get('scope')!.split(' ')).toEqual(GOOGLE_SCOPES)
  })
})

describe('no Google sign-up', () => {
  it('OAuth callback for an unknown Google user (requestSignUp:true) creates no user and no session', async () => {
    const { auth, db } = makeAuth()
    const start = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', requestSignUp: true })
    }))
    expect(start.status).toBe(200)
    const { url } = await start.json() as { url: string }
    const state = new URL(url).searchParams.get('state')!
    const cookie = start.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')

    // Google's token endpoint (code exchange) — the only network call in the callback.
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'ya29.stranger',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_SCOPES.join(' '),
      id_token: unsignedJwt({ sub: 'stranger-sub', email: 'stranger@example.com', email_verified: true, name: 'Stranger' })
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)

    const cb = await auth.handler(new Request(`${BASE}/api/auth/callback/google?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { cookie }
    }))
    // Proves the callback really reached the code exchange (not an early state failure).
    expect(fetchSpy).toHaveBeenCalled()
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toContain('error=signup_disabled')
    expect(db.user).toHaveLength(0)
    expect(db.account).toHaveLength(0)
    expect(db.session).toHaveLength(0)
  })

  it('ID-token sign-in is disabled outright (that path ignores provider disableSignUp)', async () => {
    // verifyIdToken always accepts, so ONLY disableIdTokenSignIn can stop this (it short-circuits
    // before the custom verifier in 1.6.13). Without it, this request creates the stranger.
    const { auth, db } = makeAuth({ googleOverrides: { verifyIdToken: async () => true } })
    const res = await auth.handler(new Request(`${BASE}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({
        provider: 'google',
        requestSignUp: true,
        idToken: { token: unsignedJwt({ sub: 's', email: 'stranger@example.com', email_verified: true, aud: 'cid.apps.googleusercontent.com' }) }
      })
    }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(db.user).toHaveLength(0)
  })
})

describe('encryptOAuthTokens vs email/password', () => {
  it('email/password sign-up + sign-in still work with encryptOAuthTokens on', async () => {
    const { auth, db } = makeAuth({ emailSignUp: true })
    await auth.api.signUpEmail({ body: { email: 'tony@example.com', password: 'correct-horse-battery', name: 'Tony' } })
    const signedIn = await auth.api.signInEmail({ body: { email: 'tony@example.com', password: 'correct-horse-battery' } })
    expect(signedIn.token).toBeTruthy()
    expect(db.account).toHaveLength(1)
    expect(db.account[0]!.providerId).toBe('credential')
    await expect(auth.api.signInEmail({ body: { email: 'tony@example.com', password: 'wrong-password-xx' } })).rejects.toThrow()
  })
})

describe('account hooks during a real link (what Task 2+ can rely on)', () => {
  function cookiesOf(res: Response, prev = '') {
    const jar = new Map(prev.split('; ').filter(Boolean).map(c => [c.split('=')[0]!, c] as const))
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]!; jar.set(kv.split('=')[0]!, kv) }
    return [...jar.values()].join('; ')
  }

  async function linkOnce(auth: ReturnType<typeof makeAuth>['auth'], sessionCookie: string, email: string, accessToken: string) {
    const start = await auth.handler(new Request(`${BASE}/api/auth/link-social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: sessionCookie },
      body: JSON.stringify({ provider: 'google', callbackURL: '/settings/connections' })
    }))
    expect(start.status).toBe(200)
    const { url } = await start.json() as { url: string }
    const state = new URL(url).searchParams.get('state')!
    const cookie = cookiesOf(start, sessionCookie)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: '1//refresh-' + accessToken,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: GOOGLE_SCOPES.join(' '),
      id_token: unsignedJwt({ sub: 'g-sub-1', email, email_verified: true })
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const cb = await auth.handler(new Request(`${BASE}/api/auth/callback/google?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie } }))
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).not.toContain('error')
    vi.unstubAllGlobals()
  }

  it('link (different email) fires create.after with the full row: idToken plaintext, access/refresh tokens encrypted; re-link fires update.after with the full row', async () => {
    const hookCalls: HookCall[] = []
    const { auth, db } = makeAuth({ emailSignUp: true, hookCalls })
    const signUp = await auth.handler(new Request(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ email: 'tony@example.com', password: 'correct-horse-battery', name: 'Tony' })
    }))
    const sessionCookie = cookiesOf(signUp)
    hookCalls.length = 0 // drop the credential account's create

    const googleEmail = 'tony@costanzoclan.com' // != MyMind login email → allowDifferentEmails
    await linkOnce(auth, sessionCookie, googleEmail, 'ya29.first')
    expect(hookCalls).toHaveLength(1)
    const created = hookCalls[0]!
    expect(created.kind).toBe('create')
    expect(created.row).toMatchObject({ providerId: 'google', accountId: 'g-sub-1', userId: db.user[0]!.id })
    expect(typeof created.row!.id).toBe('string')
    expect(JSON.parse(Buffer.from(String(created.row!.idToken).split('.')[1]!, 'base64url').toString()).email).toBe(googleEmail)
    expect(created.row!.accessToken).not.toBe('ya29.first') // encrypted before the write
    expect(created.row!.refreshToken).not.toContain('1//refresh')

    // Decrypts back through better-auth's own getAccessToken.
    const tok = await auth.api.getAccessToken({ body: { providerId: 'google', accountId: 'g-sub-1', userId: String(db.user[0]!.id) } })
    expect(tok.accessToken).toBe('ya29.first')

    hookCalls.length = 0
    await linkOnce(auth, sessionCookie, googleEmail, 'ya29.second') // reconnect path
    expect(hookCalls).toHaveLength(1)
    const updated = hookCalls[0]!
    expect(updated.kind).toBe('update')
    expect(updated.row).toMatchObject({ id: created.row!.id, providerId: 'google', accountId: 'g-sub-1', userId: db.user[0]!.id })
    expect(updated.row!.idToken).toBeTruthy()
    expect(updated.row!.accessToken).not.toBe('ya29.second')
  })
})
