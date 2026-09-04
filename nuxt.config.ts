// https://nuxt.com/docs/api/configuration/nuxt-config
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

// Silero VAD (client barge-in) loads its worklet + ONNX model from `baseAssetPath`
// and the onnxruntime-web WASM from `onnxWASMBasePath`. Under a bundler both default
// to "/" / "./", so the files 404 unless we serve them. Resolve the package dirs
// (robust under pnpm's nested layout) and expose them as static assets at /vad and /ort.
const require_ = createRequire(import.meta.url)
const vadAssetDir = dirname(require_.resolve('@ricky0123/vad-web/package.json')) + '/dist'
const ortAssetDir = dirname(createRequire(require_.resolve('@ricky0123/vad-web/package.json')).resolve('onnxruntime-web'))

export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@nuxtjs/mdc',
    '@vueuse/nuxt'
  ],

  devtools: {
    enabled: true
  },

  // Hybrid rendering: catch-all SPA with SSR carved out for public pages.
  //
  // Mechanism: SSR remains enabled globally (default). routeRules sets ssr:false for
  // every route via catch-all '/**', so new app pages automatically get the SPA shell
  // without needing to be listed explicitly (no pre-login flash or hydration mismatches).
  // /share/** overrides back to ssr:true, which works because the more-specific rule wins.
  //
  // NOTE: Global ssr:false + per-route ssr:true was attempted but does NOT work in Nuxt 4.
  // When ssr:false is set globally the renderer is compiled to always use getSPARenderer()
  // regardless of routeRules — the per-route override only goes the other direction
  // (SSR→SPA via routeRules ssr:false). Verified empirically in preview build.
  // The correct supported hybrid mode is: ssr:true globally + ssr:false per route.

  css: ['~/assets/css/main.css'],

  routeRules: {
    '/voice': { redirect: '/agent' },
    // Catch-all: every route is SPA by default so new pages never forget.
    '/**': { ssr: false },
    // Public share pages keep SSR for OG/SEO — more-specific rule wins.
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
    public: {
      // Whether the /login page surfaces a "create account" toggle. Mirrors the
      // server-side disableSignUp gate so the UI only shows what the API allows.
      allowSignup: process.env.ALLOW_SIGNUP === 'true'
    },
    storageDriver: process.env.STORAGE_DRIVER ?? 'local',
    storageLocalDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
    storageS3: {
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      region: process.env.STORAGE_S3_REGION,
      bucket: process.env.STORAGE_S3_BUCKET,
      accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY
    },
    memoryAutoReviewThreshold: Number(process.env.MEMORY_AUTO_REVIEW_THRESHOLD ?? 0.75),
    // Cosine bar above which the enrichment resolver treats a near-neighbour as the SAME
    // fact mechanically, without asking the LLM judge. Closes task f80622b9: the enrichment
    // path (memory-resolve.insertFresh) never ran dedupDecision, so after the exact-hash
    // check the judge alone decided — and it let 95 same-partition pairs at >= 0.85 through,
    // including near-verbatim restatements at 0.995.
    //
    // Set to 0.96, not the 0.92 originally proposed, after dry-running the backfill against
    // the real corpus: at 0.92 two of fifteen pairs were DISTINCT facts the embedding merely
    // scored close (an MCP tool-surface fact vs. an MCP default-limit fact, 0.956). A merge
    // absorbs evidence into the incumbent and discards the new phrasing, so a false positive
    // loses a fact permanently — unrecoverable in a way a surviving duplicate is not. Every
    // pair at or above 0.96 was a genuine restatement; below it goes to the judge.
    memoryDuplicateThreshold: Number(process.env.MEMORY_DUPLICATE_THRESHOLD ?? 0.96),
    // Capture triage confidence bars, per destination. ALL ship at 1.1 (= never
    // auto-apply) so the pipeline can be calibrated against real captures before it
    // is allowed to write. Lower by hand, one destination at a time, per the spec's
    // rollout. The memory bar is GATED on task f80622b9 (dedup under-catching).
    triageThresholds: {
      // Task lowered to 0.70 on 2026-08-17, the first step of the staged rollout, after a
      // day of reading real proposals in /review. Task is the safest bar to drop first:
      // the action is one row you can delete, and an undo now fully recovers (the courier
      // returns to /input and "Re-triage" puts it back in the sweeper's pool).
      task: 0.70,
      note: 1.1,
      // GATED on MyMind task f80622b9 (enrich-memories dedup under-catching). Triage is a
      // second inlet to the memories table; lowering this before that closes amplifies a
      // known defect, and bad memories degrade recall everywhere, invisibly.
      memory: 1.1,
      append: 1.1
    },
    triageAppendSimilarityFloor: 0.75
  },

  nitro: {
    experimental: { tasks: true, websocket: true },
    // Pre-compress static public assets (JS/CSS/wasm/fonts) to .gz + .br at build time.
    // Nitro serves the precompressed variant with Content-Encoding when the client offers
    // it; the proxy forwards it untouched. Without this every _nuxt chunk crossed the
    // Pangolin tunnel raw — a 713 KB JS chunk was ~180 KB brotli'd, and the onnxruntime-web
    // wasm (see publicAssets below) compresses several-fold too. Build-time cost only.
    compressPublicAssets: { gzip: true, brotli: true },
    // Serve the Silero VAD assets (worklet + ONNX model) and onnxruntime-web WASM
    // from the app origin so the client VAD can fetch them (see useVoice.ts asset paths).
    publicAssets: [
      { baseURL: 'vad', dir: vadAssetDir, maxAge: 60 * 60 * 24 * 30 },
      { baseURL: 'ort', dir: ortAssetDir, maxAge: 60 * 60 * 24 * 30 }
    ],
    serverAssets: [{ baseName: 'setup', dir: 'server/assets/setup' }],
    scheduledTasks: {
      '*/5 * * * *': ['embed-documents', 'summarize-sessions'],
      '*/10 * * * *': ['triage-input'],
      '*/7 * * * *': ['enrich-images'],
      // sync-model-prices runs often, but self-gates: it only hits the network when a model
      // appears that it has never attempted to price, or when the last full sync is >20h old.
      // Daily was ample for price CHANGES, but the real trigger is a NEW model showing up in
      // usage — claude-fable-5-1 read as unpriced for ~11h on 2026-09-03 awaiting the 04:00 run.
      '*/15 * * * *': ['enrich-memories', 'sync-model-prices'],
      '0 3 * * *': ['prune-activity-log'],
      '*/4 * * * *': ['embed-messages'],
      // Shortly after midnight UTC: summarise yesterday's LiteLLM traffic.
      '20 0 * * *': ['rollup-litellm-daily'],
      // UMAP over ~2000+ vectors is heavy + synchronous (blocks the event loop),
      // so the hourly run SKIPS the recompute unless the eligible node count
      // changed (see the job's force guard). Manual /api/graph/recompute forces
      // a full rebuild. Keeps new memories/projects appearing within the hour.
      '0 * * * *': ['compute-graph-layout']
    }
  }
})
