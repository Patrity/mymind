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

const rows = computed(() => tokens.value ?? [])

// ---- Connect: tabbed setup (Claude Code w/ OS toggle, + Screenshots) ----
const connectTabs = [
  { label: 'Claude Code', icon: 'i-lucide-terminal', slot: 'cc' as const },
  { label: 'Screenshots', icon: 'i-lucide-camera', slot: 'shots' as const }
]
const os = ref<'unix' | 'win'>('unix')
const osItems = [
  { label: 'macOS / Linux', value: 'unix' },
  { label: 'Windows', value: 'win' }
]

// .mcp.json is identical across OS — Claude Code expands ${ENV} refs in MCP config,
// so these placeholders must render literally.
const mcpSnippet = `{
  "mcpServers": {
    "mymind": {
      "type": "http",
      "url": "\${MYMIND_URL}/api/mcp",
      "headers": { "Authorization": "Bearer \${MYMIND_TOKEN}" }
    }
  }
}`

// Build the settings.json hooks block from a per-OS command builder. JSON.stringify
// guarantees correct escaping (esp. Windows backslash paths).
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd']
function hooksJson(cmd: (ev: string) => string): string {
  const hooks: Record<string, unknown> = {}
  for (const ev of EVENTS) hooks[ev] = [{ matcher: '*', hooks: [{ type: 'command', command: cmd(ev) }] }]
  return JSON.stringify({ hooks }, null, 2)
}

const steps = computed(() => {
  const tok = tokenForSnippets.value
  const tokNote = minted.value ? 'Pre-filled with your new token.' : 'Replace mm_•••• with the token you saved.'
  if (os.value === 'win') {
    return [
      { n: '1', title: 'Set your token (PowerShell)', note: tokNote, code:
`$env:MYMIND_URL = "${baseUrl.value}"
$env:MYMIND_TOKEN = "${tok}"
New-Item -ItemType Directory -Force "$HOME\\.mymind" | Out-Null
"MYMIND_URL=$env:MYMIND_URL\`nMYMIND_TOKEN=$env:MYMIND_TOKEN" | Set-Content "$HOME\\.mymind\\config.env"` },
      { n: '2', title: 'Add the MCP server (.mcp.json or ~/.claude.json)', note: undefined, code: mcpSnippet },
      { n: '2.1', title: '…or via the CLI', note: undefined, code:
`claude mcp add --transport http --scope user \`
  mymind "$env:MYMIND_URL/api/mcp" \`
  --header "Authorization: Bearer $env:MYMIND_TOKEN"` },
      { n: '3', title: 'Install the session-logging hook', note: undefined, code:
`New-Item -ItemType Directory -Force "$HOME\\.mymind" | Out-Null
Invoke-WebRequest "${baseUrl.value}/api/setup/cc-hook.ps1" -OutFile "$HOME\\.mymind\\cc-hook.ps1"` },
      { n: '3.1', title: '…then add to %USERPROFILE%\\.claude\\settings.json',
        note: 'If hooks don’t fire, replace %USERPROFILE% with your full home path (C:\\Users\\you). Running Claude Code under WSL? Use the macOS / Linux tab instead.',
        code: hooksJson(ev => `powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\.mymind\\cc-hook.ps1" ${ev}`) }
    ]
  }
  return [
    { n: '1', title: 'Set your token', note: tokNote, code:
`export MYMIND_URL="${baseUrl.value}"
export MYMIND_TOKEN="${tok}"
mkdir -p ~/.mymind && printf 'MYMIND_URL=%s\\nMYMIND_TOKEN=%s\\n' "$MYMIND_URL" "$MYMIND_TOKEN" > ~/.mymind/config.env` },
    { n: '2', title: 'Add the MCP server (.mcp.json or ~/.claude.json)', note: undefined, code: mcpSnippet },
    { n: '2.1', title: '…or via the CLI', note: undefined, code:
`claude mcp add --transport http --scope user \\
  mymind "\${MYMIND_URL}/api/mcp" \\
  --header "Authorization: Bearer \${MYMIND_TOKEN}"` },
    { n: '3', title: 'Install the session-logging hook', note: undefined, code:
`mkdir -p ~/.mymind && curl -fsSL "${baseUrl.value}/api/setup/cc-hook" -o ~/.mymind/cc-hook.sh && chmod +x ~/.mymind/cc-hook.sh` },
    { n: '3.1', title: '…then add to ~/.claude/settings.json',
      note: 'If hooks don’t fire, replace ~ with $HOME in each command.',
      code: hooksJson(ev => `~/.mymind/cc-hook.sh ${ev}`) }
  ]
})

// ---- Screenshots: ShareX / CleanShot custom uploader (.sxcu) ----
const sxcuSnippet = computed(() => JSON.stringify({
  Version: '1.0.0',
  Name: 'MyMind',
  DestinationType: 'ImageUploader, FileUploader',
  RequestMethod: 'POST',
  RequestURL: `${baseUrl.value}/api/upload?public=1`,
  Headers: { Authorization: `Bearer ${tokenForSnippets.value}` },
  Body: 'MultipartFormData',
  FileFormName: 'file',
  URL: '{json:url}'
}, null, 2))

function downloadSxcu() {
  if (!import.meta.client) return
  const blob = new Blob([sxcuSnippet.value], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'mymind.sxcu'
  a.click()
  URL.revokeObjectURL(a.href)
}
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
        <h2 class="text-base font-semibold text-highlighted">Connect</h2>
        <p class="text-sm text-muted">Run these once on each machine. Snippets carry no secret beyond your token.</p>
      </div>

      <UTabs :items="connectTabs" class="w-full">
        <template #cc>
          <div class="flex flex-col gap-4 pt-2">
            <div class="flex items-center gap-3">
              <span class="text-sm text-muted">OS</span>
              <UTabs v-model="os" :items="osItems" :content="false" color="neutral" size="xs" class="w-auto" />
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
        </template>

        <template #shots>
          <div class="flex flex-col gap-4 pt-2">
            <p class="text-sm text-muted">
              MyMind hosts screenshots ShareX/CleanShot-style — uploads get a public link and are auto-OCR'd and searchable in your
              <NuxtLink to="/gallery" class="text-primary">gallery</NuxtLink>. Import this custom uploader once.
            </p>
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-sm font-medium text-toned">mymind.sxcu — ShareX &amp; CleanShot X</span>
                <div class="flex gap-1">
                  <UButton size="xs" icon="i-lucide-download" color="neutral" variant="ghost" label="Download" @click="downloadSxcu" />
                  <UButton size="xs" icon="i-lucide-copy" color="neutral" variant="ghost" @click="copy(sxcuSnippet)" />
                </div>
              </div>
              <pre class="bg-elevated border border-default rounded-md p-3 text-xs font-mono overflow-x-auto whitespace-pre">{{ sxcuSnippet }}</pre>
            </div>
            <div class="text-xs text-muted flex flex-col gap-2">
              <p><span class="font-medium text-toned">ShareX:</span> Destinations → Custom uploader settings → Import → From file… → pick <code class="font-mono">mymind.sxcu</code>, then set Destinations → Image uploader → <code class="font-mono">MyMind</code>.</p>
              <p><span class="font-medium text-toned">CleanShot X:</span> Settings → Uploads → Custom → import the same <code class="font-mono">.sxcu</code>, then choose it as the active destination.</p>
            </div>
          </div>
        </template>
      </UTabs>
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
