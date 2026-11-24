import { defineConfig } from 'vitest/config'

// Hits the real internet (tls.peet.ws, AniList, reanime.cz, anizone.to). Only via `pnpm test:live`.
// RECORD=1 pnpm test:live also re-records the golden-set fixture.
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 120_000,
  },
})
