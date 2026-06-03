// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/mdc'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/': { redirect: '/documents' },
    '/share/**': { ssr: true }
  },

  compatibilityDate: '2025-01-15',

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  runtimeConfig: {
    databaseUrl: process.env.DATABASE_URL,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    allowSignup: process.env.ALLOW_SIGNUP,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 52428800),
    storageDriver: process.env.STORAGE_DRIVER ?? 'local',
    storageLocalDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
    storageS3: {
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION,
      bucket: process.env.STORAGE_S3_BUCKET,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY
    },
    ai: {
      reasoning: { baseURL: process.env.AI_REASONING_BASE_URL, apiKey: process.env.AI_REASONING_API_KEY, model: process.env.AI_REASONING_MODEL },
      bulk: { baseURL: process.env.AI_BULK_BASE_URL, apiKey: process.env.AI_BULK_API_KEY, model: process.env.AI_BULK_MODEL },
      embeddings: { baseURL: process.env.AI_EMBEDDINGS_BASE_URL, apiKey: process.env.AI_EMBEDDINGS_API_KEY, model: process.env.AI_EMBEDDINGS_MODEL },
      vision: { baseURL: process.env.AI_VISION_BASE_URL, apiKey: process.env.AI_VISION_API_KEY, model: process.env.AI_VISION_MODEL },
      stt: { baseURL: process.env.AI_STT_BASE_URL, apiKey: process.env.AI_STT_API_KEY },
      tts: { baseURL: process.env.AI_TTS_BASE_URL, apiKey: process.env.AI_TTS_API_KEY }
    }
  },

  nitro: {
    experimental: { tasks: true },
    scheduledTasks: {
      '*/5 * * * *': ['embed-documents'],
      '*/10 * * * *': ['enrich-input'],
      '*/7 * * * *': ['ocr-images'],
      '*/15 * * * *': ['enrich-memories']
    }
  }
})
