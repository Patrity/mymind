// One-off: repoint the (formerly anthropic) Claude provider at the LiteLLM
// OpenAI-compatible gateway so the stored ai_config is valid under the new
// single-kind schema, and make local qwen the primary reasoning model with
// Claude-via-LiteLLM as failover. Idempotent.
//
// Run: node --import tsx --env-file=.env scripts/migrate-ai-config-litellm.ts
import { Client } from 'pg'
import { encryptSecret } from '../server/lib/ai/registry/crypto'
import { parseConfig } from '../server/lib/ai/registry/schema'

const LITELLM_BASE_URL = 'https://lite.costanzoclan.com/v1'
const LITELLM_API_KEY = process.env.LITELLM_API_KEY
if (!LITELLM_API_KEY) throw new Error('set LITELLM_API_KEY in the environment for this run')

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()

const { rows } = await client.query<{ value: unknown }>(`select value from settings where key = 'ai_config'`)
if (!rows[0]) throw new Error('no ai_config row found')
const doc = rows[0].value as {
  providers: { id: string; kind: string; baseURL: string | null; apiKeyEnc: string | null; name: string }[]
  models: { id: string; modelId: string; providerId: string }[]
  assignments: Record<string, string[]>
}

// Find the Claude/Haiku provider: the one currently kind=anthropic, or the
// provider behind a claude-* model.
const claudeModel = doc.models.find(m => m.modelId.startsWith('claude-'))
const claudeProviderId = claudeModel?.providerId
  ?? doc.providers.find(p => p.kind === 'anthropic')?.id

const provider = doc.providers.find(p => p.id === claudeProviderId)
if (!provider) throw new Error('could not locate the Claude provider')

provider.kind = 'openai-compatible'
provider.baseURL = LITELLM_BASE_URL
provider.apiKeyEnc = encryptSecret(LITELLM_API_KEY)
if (!provider.name || provider.name === 'New provider') provider.name = 'LiteLLM (Claude)'

// Reasoning chain: local qwen primary (free, proven), Claude-via-LiteLLM failover.
const qwenReasoning = doc.models.find(m => m.modelId.includes('qwen') && doc.assignments.reasoning?.includes(m.id))
const claudeId = claudeModel?.id
if (qwenReasoning && claudeId) {
  doc.assignments.reasoning = [qwenReasoning.id, claudeId]
}

const validated = parseConfig(doc)  // throws if anything is still off
await client.query(
  `update settings set value = $1, updated_at = now() where key = 'ai_config'`,
  [JSON.stringify(validated)]
)
await client.end()

console.log('ai_config migrated:')
console.log('  provider:', provider.id, '->', provider.baseURL, '(kind:', provider.kind + ')')
console.log('  reasoning chain:', validated.assignments.reasoning)
