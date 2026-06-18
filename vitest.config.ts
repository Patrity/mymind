import { defineConfig } from 'vitest/config'

// Minimal config: keep vitest's default test discovery but also exclude
// `.claude/**` so leftover agent git-worktrees under `.claude/worktrees/*`
// (which carry their own duplicate `test/` dirs) don't get double-discovered
// and inflate/confuse the suite. Mirrors vitest's default exclude list + that path.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/.claude/**'
    ]
  }
})
