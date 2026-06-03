<script setup lang="ts">
// CameraCapture.vue — live getUserMedia preview → emit('capture', File) on snap

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  capture: [file: File]
}>()

// VueUse useUserMedia — auto-imported via @vueuse/nuxt
const { stream, start, stop, isSupported } = useUserMedia({
  constraints: { video: { facingMode: 'environment' }, audio: false }
})

const videoRef = ref<HTMLVideoElement | null>(null)
const permissionError = ref(false)
const canvas = ref<HTMLCanvasElement | null>(null)

// Start/stop the camera based on the open prop
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      permissionError.value = false
      try {
        await start()
      } catch {
        permissionError.value = true
      }
    } else {
      stop()
    }
  }
)

// Bind stream to video element once both are ready
watch(
  [stream, videoRef],
  ([s, el]) => {
    if (el && s) {
      el.srcObject = s
    }
  }
)

// Stop stream on unmount to avoid leaving camera LED on
onUnmounted(() => stop())

function closeModal() {
  stop()
  emit('update:open', false)
}

function captureFrame() {
  const video = videoRef.value
  const cvs = canvas.value
  if (!video || !cvs) return

  cvs.width = video.videoWidth
  cvs.height = video.videoHeight
  cvs.getContext('2d')?.drawImage(video, 0, 0)

  cvs.toBlob((blob) => {
    if (!blob) return
    const ts = Date.now()
    const file = new File([blob], `capture-${ts}.png`, { type: 'image/png' })
    emit('capture', file)
    closeModal()
  }, 'image/png')
}
</script>

<template>
  <UModal
    :open="open"
    title="Camera Capture"
    @update:open="(v) => !v && closeModal()"
  >
    <template #body>
      <!-- No camera support -->
      <div
        v-if="!isSupported"
        class="flex flex-col items-center gap-4 py-6 text-center"
      >
        <UIcon
          name="i-lucide-camera-off"
          class="size-10 text-muted"
        />
        <p class="text-sm text-muted">
          Camera access is not supported in this browser.
        </p>
        <UButton
          variant="soft"
          @click="closeModal"
        >
          Close
        </UButton>
      </div>

      <!-- Permission denied or other error -->
      <div
        v-else-if="permissionError"
        class="flex flex-col items-center gap-4 py-6 text-center"
      >
        <UIcon
          name="i-lucide-shield-off"
          class="size-10 text-warning"
        />
        <p class="text-sm text-muted">
          Camera permission was denied. Please allow camera access in your browser settings and try again.
        </p>
        <UButton
          variant="soft"
          @click="closeModal"
        >
          Close
        </UButton>
      </div>

      <!-- Live camera preview -->
      <div
        v-else
        class="flex flex-col items-center gap-4"
      >
        <video
          ref="videoRef"
          autoplay
          playsinline
          muted
          class="w-full rounded-lg bg-black max-h-80 object-cover"
        />
        <!-- Hidden canvas used to grab a frame -->
        <canvas
          ref="canvas"
          class="hidden"
        />
        <div class="flex gap-3">
          <UButton
            icon="i-lucide-camera"
            :disabled="!stream"
            @click="captureFrame"
          >
            Capture
          </UButton>
          <UButton
            variant="soft"
            color="neutral"
            @click="closeModal"
          >
            Cancel
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
