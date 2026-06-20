// app/composables/useExecSecrets.ts
// Write-only secrets store: GET returns only {name, lastFour} (never plaintext).

export interface SecretMeta { name: string; lastFour: string }

export function useExecSecrets() {
  const secrets = useState<SecretMeta[]>('exec-secrets', () => [])
  const error = useState<string | null>('exec-secrets-err', () => null)

  async function load() {
    secrets.value = (await $fetch<{ secrets: SecretMeta[] }>('/api/settings/exec-secrets')).secrets
  }

  async function add(name: string, value: string) {
    error.value = null
    try {
      await $fetch('/api/settings/exec-secrets', { method: 'PUT', body: { name, value } })
      await load()
    } catch (e) {
      error.value = (e as { data?: { message?: string } }).data?.message ?? (e as Error).message
      throw e
    }
  }

  async function remove(name: string) {
    error.value = null
    try {
      await $fetch('/api/settings/exec-secrets', { method: 'DELETE', query: { name } })
      await load()
    } catch (e) {
      error.value = (e as { data?: { message?: string } }).data?.message ?? (e as Error).message
      throw e
    }
  }

  return { secrets, error, load, add, remove }
}
