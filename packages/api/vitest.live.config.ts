import { defineConfig } from 'vitest/config'

// Hits the real internet. Only via `pnpm test:live`.
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 180_000,
  },
})
