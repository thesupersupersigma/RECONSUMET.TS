import { defineConfig } from 'vitest/config'

// Hits the real internet (tls.peet.ws). Only via `pnpm test:live`.
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 60_000,
  },
})
