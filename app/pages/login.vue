<script setup lang="ts">
import type { FormSubmitEvent } from '#ui/types'
import { authClient } from '~/lib/auth-client'

definePageMeta({ layout: false })

interface LoginForm {
  name?: string
  email: string
  password: string
}

const allowSignup = useRuntimeConfig().public.allowSignup
const mode = ref<'signin' | 'register'>('signin')
const isRegister = computed(() => mode.value === 'register')

const error = ref<string | null>(null)
const loading = ref(false)

const fields = computed(() => [
  ...(isRegister.value
    ? [{
        name: 'name',
        type: 'text' as const,
        label: 'Name',
        placeholder: 'Your name',
        required: true,
        autocomplete: 'name'
      }]
    : []),
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
    autocomplete: isRegister.value ? 'new-password' : 'current-password'
  }
])

function toggleMode() {
  error.value = null
  mode.value = isRegister.value ? 'signin' : 'register'
}

async function onSubmit(event: FormSubmitEvent<LoginForm>) {
  error.value = null
  loading.value = true
  try {
    const result = isRegister.value
      ? await authClient.signUp.email({
          name: event.data.name ?? '',
          email: event.data.email,
          password: event.data.password
        })
      : await authClient.signIn.email({
          email: event.data.email,
          password: event.data.password
        })
    if (result.error) {
      error.value = result.error.message ?? (isRegister.value ? 'Could not create account' : 'Invalid credentials')
    } else {
      await navigateTo('/documents')
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : (isRegister.value ? 'Sign up failed' : 'Sign in failed')
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
        :title="isRegister ? 'Create account' : 'Sign in'"
        :description="isRegister ? 'Register the first user to get started.' : 'Enter your credentials to continue.'"
        :fields="fields"
        :submit="{ label: isRegister ? 'Create account' : 'Sign in', loading }"
        @submit="onSubmit"
      />

      <p
        v-if="allowSignup"
        class="text-center text-sm text-muted"
      >
        {{ isRegister ? 'Already have an account?' : 'Need to register the first user?' }}
        <UButton
          variant="link"
          :padded="false"
          class="p-0"
          @click="toggleMode"
        >
          {{ isRegister ? 'Sign in' : 'Create account' }}
        </UButton>
      </p>
    </div>
  </div>
</template>
