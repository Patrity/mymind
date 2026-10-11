// app/composables/useExecSecrets.ts
// Write-only secrets store: GET returns only {name, lastFour} (never plaintext).

export interface SecretMeta { name: string; lastFour: string; sandbox: boolean }

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

  /** Cycle 82 Task 3: opt a secret in to / out of the workspace sandbox (session-only route). */
  async function setSandbox(name: string, sandbox: boolean) {
    error.value = null
    try {
      await $fetch('/api/settings/exec-secrets/sandbox', { method: 'PUT', body: { name, sandbox } })
    } catch (e) {
      error.value = (e as { data?: { data?: { message?: string }; message?: string } }).data?.data?.message ?? (e as { data?: { message?: string } }).data?.message ?? (e as Error).message
    } finally {
      await load()
    }
  }

  return { secrets, error, load, add, remove, setSandbox }
}
