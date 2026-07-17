// Usage: node scripts/mcp-oauth-e2e.mjs <base> <code|""> [verifier] [client_id]
//   Phase 1 (no code): registers a DCR client, prints the authorize URL + verifier + client_id.
//   Phase 2 (code + verifier + client_id): exchanges the code, calls /api/mcp, prints results.
import { createHash, randomBytes } from 'node:crypto'

const [base = 'http://localhost:3000', code = '', verifierArg = '', clientIdArg = ''] = process.argv.slice(2)
const REDIRECT = 'http://127.0.0.1:19191/cb' // never listened on; we read the code off the URL bar

if (!code) {
  const reg = await fetch(`${base}/api/auth/mcp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'mcp-oauth-e2e',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  }).then(r => r.json())
  if (!reg.client_id) throw new Error('DCR failed: ' + JSON.stringify(reg))

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid profile offline_access',
    state: 'e2e-state',
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })
  console.log('VERIFIER=' + verifier)
  console.log('CLIENT_ID=' + reg.client_id)
  console.log('AUTHORIZE_URL=' + `${base}/api/auth/mcp/authorize?${q}`)
} else {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifierArg,
    client_id: clientIdArg // required for public clients (OAuth 2.1 §4.1.3)
  })
  const tok = await fetch(`${base}/api/auth/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  }).then(r => r.json())
  if (!tok.access_token) throw new Error('token exchange failed: ' + JSON.stringify(tok))
  console.log('TOKEN_OK expires_in=' + tok.expires_in + ' refresh=' + Boolean(tok.refresh_token))

  const mcp = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'authorization': `Bearer ${tok.access_token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })
  const text = await mcp.text()
  console.log('MCP_STATUS=' + mcp.status)
  console.log('MCP_HAS_TOOLS=' + text.includes('"tools"'))
}
