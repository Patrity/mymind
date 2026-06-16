<!-- app/components/settings/ApiKeysTab.vue -->
<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import type { ApiTokenDTO } from '~/composables/useApiTokens'

const { useTokenList, create, revoke } = useApiTokens()
const { data: tokens, error } = useTokenList()
const qc = useQueryClient()
const toast = useToast()

const baseUrl = computed(() => import.meta.client ? window.location.origin : '')

const createOpen = ref(false)
const newName = ref('')
const creating = ref(false)
const minted = ref<(ApiTokenDTO & { token: string }) | null>(null)

async function submitCreate() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    minted.value = await create(newName.value.trim())
    newName.value = ''
    createOpen.value = false
    qc.invalidateQueries({ queryKey: ['apiToken', 'list'] })
  } catch {
    toast.add({ title: 'Failed to create token', color: 'error' })
  } finally {
    creating.value = false
  }
}

async function doRevoke(t: ApiTokenDTO) {
  try {
    await revoke(t.id)
    qc.invalidateQueries({ queryKey: ['apiToken', 'list'] })
    toast.add({ title: `Revoked "${t.name}"`, color: 'neutral' })
  } catch {
    toast.add({ title: 'Failed to revoke token', color: 'error' })
  }
}

function copy(text: string) {
  if (import.meta.client) navigator.clipboard?.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}

const tokenForSnippets = computed(() => minted.value?.token ?? 'mm_•••••••• (paste your saved token)')

// Env-var references like ${MYMIND_URL} are intentional — they must render literally for the user's shell.
const mcpSnippet = computed(() => `{
  "mcpServers": {
    "mymind": {
      "type": "http",
      "url": "\${MYMIND_URL}/api/mcp",
      "headers": { "Authorization": "Bearer \${MYMIND_TOKEN}" }
    }
  }
}`)

const mcpCli = computed(() =>
  `claude mcp add --transport http --scope user \\
  --header "Authorization: Bearer \${MYMIND_TOKEN}" \\
  mymind "\${MYMIND_URL}/api/mcp"`)

const envSnippet = computed(() =>
  `export MYMIND_URL="${baseUrl.value}"
export MYMIND_TOKEN="${tokenForSnippets.value}"
mkdir -p ~/.mymind && printf 'MYMIND_URL=%s\\nMYMIND_TOKEN=%s\\n' "$MYMIND_URL" "$MYMIND_TOKEN" > ~/.mymind/config.env`)

const installSnippet = computed(() =>
  `mkdir -p ~/.mymind && curl -fsSL "${baseUrl.value}/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x ~/.mymind/cc-hook.sh`)

const hooksSnippet = computed(() => `{
  "hooks": {
    "SessionStart":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SessionStart" }] }],
    "UserPromptSubmit":[{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh UserPromptSubmit" }] }],
    "PreToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh PreToolUse" }] }],
    "PostToolUse":     [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh PostToolUse" }] }],
    "Stop":            [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh Stop" }] }],
    "SubagentStop":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SubagentStop" }] }],
    "SessionEnd":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/.mymind/cc-hook.sh SessionEnd" }] }]
  }
}`)

const rows = computed(() => tokens.value ?? [])

const steps = computed(() => [
  { n: '1', title: 'Set your token', code: envSnippet.value, note: minted.value ? 'Pre-filled with your new token.' : 'Replace mm_•••• with the token you saved.' },
  { n: '2', title: 'Add the MCP server (.mcp.json or ~/.claude.json)', code: mcpSnippet.value, note: undefined },
  { n: '2.1', title: '…or via the CLI', code: mcpCli.value, note: undefined },
  { n: '3', title: 'Install the session-logging hook', code: installSnippet.value, note: undefined },
  { n: '3.1', title: '…then add to ~/.claude/settings.json', code: hooksSnippet.value, note: undefined },
])
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold text-highlighted">API keys</h2>
        <p class="text-sm text-muted">Bearer tokens for ShareX uploads, the Claude Code hooks, and MCP.</p>
      </div>
      <UButton icon="i-lucide-plus" label="Create token" color="primary" @click="createOpen = true" />
    </div>

    <UAlert v-if="error" color="error" icon="i-lucide-alert-circle" title="Couldn't load tokens" />

    <UAlert
      v-if="minted"
      color="warning"
      icon="i-lucide-key-round"
      title="Copy your token now — you won't see it again"
      :close="true"
      @update:open="(o: boolean) => { if (!o) minted = null }"
    >
      <template #description>
        <div class="flex items-center gap-2 mt-2">
          <code class="font-mono text-sm bg-elevated px-2 py-1 rounded break-all flex-1">{{ minted.token }}</code>
          <UButton size="xs" icon="i-lucide-copy" color="neutral" @click="copy(minted!.token)" />
        </div>
      </template>
    </UAlert>

    <div class="flex flex-col divide-y divide-default border border-default rounded-lg">
      <div v-for="t in rows" :key="t.id" class="flex items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-0">
          <div class="font-medium text-default truncate">{{ t.name }}</div>
          <div class="text-xs text-muted font-mono">mm_…{{ t.lastFour ?? '????' }}</div>
        </div>
        <div class="text-xs text-muted hidden sm:block">{{ new Date(t.createdAt).toLocaleDateString() }}</div>
        <div class="text-xs text-muted hidden sm:block w-28 text-right">
          {{ t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used' }}
        </div>
        <UBadge :color="t.revokedAt ? 'neutral' : 'success'" variant="subtle">
          {{ t.revokedAt ? 'Revoked' : 'Active' }}
        </UBadge>
        <UButton v-if="!t.revokedAt" size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="doRevoke(t)" />
      </div>
      <div v-if="rows.length === 0" class="px-4 py-6 text-sm text-muted text-center">
        No tokens yet. Create one to connect Claude Code.
      </div>
    </div>

    <div class="flex flex-col gap-4 border-t border-default pt-6">
      <div>
        <h2 class="text-base font-semibold text-highlighted">Connect to Claude Code</h2>
        <p class="text-sm text-muted">Run these once on each machine. Snippets carry no secret — your token lives in two env vars.</p>
      </div>

      <div v-for="step in steps" :key="step.n">
        <div class="flex items-center justify-between mb-1">
          <span class="text-sm font-medium text-toned">{{ step.title }}</span>
          <UButton size="xs" icon="i-lucide-copy" color="neutral" variant="ghost" @click="copy(step.code)" />
        </div>
        <p v-if="step.note" class="text-xs text-muted mb-1">{{ step.note }}</p>
        <pre class="bg-elevated border border-default rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre">{{ step.code }}</pre>
      </div>
    </div>

    <UModal v-model:open="createOpen" title="Create API token">
      <template #body>
        <UFormField label="Name" help="A label so you remember what this token is for (e.g. 'laptop ShareX').">
          <UInput v-model="newName" placeholder="my-laptop" autofocus @keyup.enter="submitCreate" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton label="Cancel" color="neutral" variant="ghost" @click="createOpen = false" />
          <UButton label="Create" color="primary" :loading="creating" :disabled="!newName.trim()" @click="submitCreate" />
        </div>
      </template>
    </UModal>
  </div>
</template>
