// Settings → Channels (cycle 75): a draft of the channel settings DTO, saved with one PUT.
// Mirrors useObservabilityConfig. The BlueBubbles password is write-only: the draft carries
// `password` as { password } (replace), { keep: true } (unchanged) or null (none set), exactly
// the PUT's shape; `hasPassword` is what the server reports.
type PasswordField = { password: string } | { keep: true } | null

export interface ChannelsConfigDoc {
  imessage: {
    enabled: boolean
    serverUrl: string
    allowedHandles: string[]
    defaultHandle: string | null
    defaultChatGuid: string | null
    hasPassword: boolean
    webhookUrlPath: string
  }
  email: { enabled: boolean, to: string | null, resendReady: boolean }
  presenceAwayMinutes: number
}
export interface DraftChannelsConfig extends ChannelsConfigDoc {
  imessage: ChannelsConfigDoc['imessage'] & { password: PasswordField }
}
export interface IMessageTestResult { privateApi: boolean, serverVersion: string, detectedIcloud: string | null, deliveryId?: string }
export interface ChannelsStatus {
  imessage: { enabled: boolean, ok: boolean, privateApi: boolean | null, checkedAt: number | null, error?: string }
  email: { enabled: boolean, ready: boolean }
}

/** The server's message for a failed $fetch (createError's statusMessage, or a 422's zod detail). */
export function fetchErrorMessage(err: unknown): string {
  const e = err as { data?: { statusMessage?: string, data?: string }, statusMessage?: string, message?: string }
  return e.data?.data ?? e.data?.statusMessage ?? e.statusMessage ?? e.message ?? 'Request failed'
}

function toDraft(doc: ChannelsConfigDoc): DraftChannelsConfig {
  return { ...doc, imessage: { ...doc.imessage, password: doc.imessage.hasPassword ? { keep: true } : null } }
}

export function useChannelsConfig() {
  const draft = ref<DraftChannelsConfig | null>(null)
  const saving = ref(false)

  async function load() {
    draft.value = toDraft(await $fetch<ChannelsConfigDoc>('/api/settings/channels'))
  }

  async function save() {
    const d = draft.value
    if (!d) return
    saving.value = true
    try {
      const doc = await $fetch<ChannelsConfigDoc>('/api/settings/channels', {
        method: 'PUT',
        body: {
          imessage: {
            enabled: d.imessage.enabled,
            serverUrl: d.imessage.serverUrl.trim(),
            password: d.imessage.password,
            allowedHandles: d.imessage.allowedHandles,
            defaultHandle: d.imessage.defaultHandle
          },
          email: { enabled: d.email.enabled, to: d.email.to?.trim() || null },
          presenceAwayMinutes: d.presenceAwayMinutes
        }
      })
      draft.value = toDraft(doc)
    } finally { saving.value = false }
  }

  /** Rotate the webhook token. Only the URL changes in the draft — unsaved edits survive. */
  async function regenerateToken() {
    const doc = await $fetch<ChannelsConfigDoc>('/api/settings/channels/regenerate-token', { method: 'POST' })
    if (draft.value) draft.value.imessage.webhookUrlPath = doc.imessage.webhookUrlPath
  }

  const testIMessage = (send: boolean) =>
    $fetch<IMessageTestResult>('/api/settings/channels/test-imessage', { method: 'POST', body: { send } })

  const testEmail = () =>
    $fetch<{ deliveryId: string }>('/api/settings/channels/test-email', { method: 'POST' })

  return { draft, saving, load, save, regenerateToken, testIMessage, testEmail }
}
