import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.live.test.ts'], // internet tests: pnpm test:live
    testTimeout: 15_000,
  },
})
