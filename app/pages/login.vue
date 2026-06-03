<script setup lang="ts">
import type { FormSubmitEvent } from '#ui/types'
import { authClient } from '~/lib/auth-client'

definePageMeta({ layout: false })

interface LoginForm {
  email: string
  password: string
}

const error = ref<string | null>(null)
const loading = ref(false)

const fields = [
  {
    name: 'email',
    type: 'email' as const,
    label: 'Email',
    placeholder: 'you@example.com',
    required: true,
    autocomplete: 'email'
  },
  {
    name: 'password',
    type: 'password' as const,
    label: 'Password',
    placeholder: '••••••••',
    required: true,
    autocomplete: 'current-password'
  }
]

async function onSubmit(event: FormSubmitEvent<LoginForm>) {
  error.value = null
  loading.value = true
  try {
    const result = await authClient.signIn.email({
      email: event.data.email,
      password: event.data.password
    })
    if (result.error) {
      error.value = result.error.message ?? 'Invalid credentials'
    } else {
      await navigateTo('/documents')
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Sign in failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-4">
    <div class="w-full max-w-sm space-y-4">
      <div class="flex items-center justify-center gap-2 mb-6">
        <UIcon
          name="i-lucide-brain"
          class="size-8 text-primary"
        />
        <span class="text-xl font-semibold tracking-tight">MyMind</span>
      </div>

      <UAlert
        v-if="error"
        color="error"
        :title="error"
        icon="i-lucide-circle-alert"
        class="mb-2"
      />

      <UAuthForm
        title="Sign in"
        description="Enter your credentials to continue."
        :fields="fields"
        :submit="{ label: 'Sign in', loading }"
        @submit="onSubmit"
      />
    </div>
  </div>
</template>
