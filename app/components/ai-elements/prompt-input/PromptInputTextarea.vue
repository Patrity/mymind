<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { InputGroupTextarea } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'
import { computed, ref } from 'vue'
import { usePromptInput } from './context'

type PromptInputTextareaProps = InstanceType<typeof InputGroupTextarea>['$props']

interface Props extends /* @vue-ignore */ PromptInputTextareaProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()

// `keydown` is a declared emit (not a plain fallthrough attr) so a caller-supplied
// listener runs INSIDE this handler, before the submit logic below, rather than as a
// second native DOM listener racing it (Vue merges fallthrough `@keydown` AFTER this
// component's own template-bound listener, which would lose that race every time).
// A caller that calls preventDefault() — the composer's `/` command menu, task-5
// fix round 1 — is signalling "I already handled this key"; Enter then skips the
// submit branch entirely instead of racing it.
const emit = defineEmits<{ keydown: [KeyboardEvent] }>()

const { textInput, setTextInput, addFiles, files, removeFile } = usePromptInput()
const isComposing = ref(false)

function handleKeyDown(e: KeyboardEvent) {
  emit('keydown', e)

  if (e.key === 'Enter') {
    if (e.defaultPrevented)
      return

    if (isComposing.value || e.isComposing || e.shiftKey)
      return

    e.preventDefault()

    const textarea = e.currentTarget as HTMLTextAreaElement | null
    const submitButton = textarea?.form?.querySelector('button[type="submit"]') as HTMLButtonElement | null

    if (submitButton?.disabled)
      return

    textarea?.form?.requestSubmit()
  }

  // Remove last attachment on backspace if input is empty
  if (e.key === 'Backspace' && textInput.value === '' && files.value.length > 0) {
    e.preventDefault()

    const lastFile = files.value[files.value.length - 1]
    if (lastFile) {
      removeFile(lastFile.id)
    }
  }
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items)
    return

  const pastedFiles: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file)
        pastedFiles.push(file)
    }
  }

  if (pastedFiles.length > 0) {
    e.preventDefault()
    addFiles(pastedFiles)
  }
}

const modelValue = computed({
  get: () => textInput.value,
  set: val => setTextInput(val),
})
</script>

<template>
  <InputGroupTextarea
    v-model="modelValue"
    placeholder="What would you like to know?"
    name="message"
    :class="cn('field-sizing-content max-h-48 min-h-16', props.class)"
    v-bind="props"
    @keydown="handleKeyDown"
    @paste="handlePaste"
    @compositionstart="isComposing = true"
    @compositionend="isComposing = false"
  />
</template>
