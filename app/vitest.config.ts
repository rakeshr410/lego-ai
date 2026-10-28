import { defineConfig } from 'vitest/config';

// Unit tests for server modules and pure logic (`npm test`). Browser flows live in e2e/
// (Playwright, `npm run test:e2e`).
//
// Astro's `astro:env/server` is stubbed so env() reads process.env live, as it does in
// production; tests change settings with vi.stubEnv().
const astroEnvStub = {
  name: 'arrowbox:astro-env-stub',
  resolveId: (id: string) => (id === 'astro:env/server' ? '\0astro-env-server' : null),
  load: (id: string) => (id === '\0astro-env-server' ? 'export const getSecret = (key) => process.env[key];' : null),
};
// `astro:prefetch` (the picker prefetches the topic Start opens) does nothing in tests, which mock it.
const astroPrefetchStub = {
  name: 'arrowbox:astro-prefetch-stub',
  resolveId: (id: string) => (id === 'astro:prefetch' ? '\0astro-prefetch' : null),
  load: (id: string) => (id === '\0astro-prefetch' ? 'export const prefetch = () => {};' : null),
};

export default defineConfig({
  plugins: [astroEnvStub, astroPrefetchStub],
  test: {
    environment: 'node',
    // scripts/drain.test.ts: the production entry's graceful shutdown (the other scripts' tests use node --test).
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/drain.test.ts', 'eval/**/*.test.ts'],
    // Ask mode is off in the default build (PUBLIC_ASK_ENABLED) and its runtime switch is off by
    // default (ASK_ENABLED); its unit tests run as a launched deploy would, with both on. The tests
    // of the default build turn the flag off themselves (vi.stubEnv, then a fresh import).
    env: { PUBLIC_ASK_ENABLED: 'true', ASK_ENABLED: 'true', PUBLIC_LABS_ENABLED: 'true' },
    // Many route tests re-import their module graph (vi.resetModules), which can pass 5s on a busy
    // machine or CI runner; a slow test is not a failing one.
    testTimeout: 20_000,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
