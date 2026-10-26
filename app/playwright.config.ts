import { defineConfig, devices } from '@playwright/test';

// Browser tests of the mock interview against the BUILT app (`npm run build` first, with
// PUBLIC_INTERVIEW_ENABLED=true), behind the edge router (scripts/edge.mjs) that puts it on one
// origin with the main site, as the load balancer does in production. The Anthropic API is mocked
// (e2e/mock-anthropic.mjs). The main site (lego/web, with LEGO_AI_SECRET set to the same value),
// its Strapi and Redis must already be running:
//
//   WEB_URL=http://localhost:4321 REDIS_URL=redis://localhost:6379 LEGO_AI_SECRET=... npm run test:e2e
//
// Set E2E_BASE_URL to test a deploy you started yourself (an origin serving both apps); nothing is
// started then. Strapi needs EMAIL_CONFIRMATION=false (the spec signs a reader up).

const PORT = Number(process.env.E2E_PORT ?? 4400);
const AI_PORT = Number(process.env.E2E_AI_PORT ?? 4401);
const MOCK_PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4410);
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:4321';
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }], ['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : [
        {
          command: 'node e2e/mock-anthropic.mjs',
          url: `http://127.0.0.1:${MOCK_PORT}/health`,
          reuseExistingServer: !process.env.CI,
          env: { MOCK_ANTHROPIC_PORT: String(MOCK_PORT) },
        },
        {
          command: 'node scripts/serve.ts',
          url: `http://localhost:${AI_PORT}/api/health`,
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          env: {
            ...(process.env as Record<string, string>),
            HOST: '0.0.0.0',
            PORT: String(AI_PORT),
            // A production build: it needs the same settings a deploy does.
            PUBLIC_ORIGIN: baseURL,
            TRUST_PROXY: process.env.TRUST_PROXY ?? '1',
            REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
            WEB_INTERNAL_URL: WEB_URL,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
            ANTHROPIC_API_KEY: 'e2e-mock-anthropic-key-not-a-secret',
            // The gateway's runtime switch (off by default); the interview's calls pass it.
            ASK_ENABLED: process.env.ASK_ENABLED ?? 'true',
            LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
          },
        },
        {
          command: 'node scripts/edge.mjs',
          url: `${baseURL}/__edge/health`,
          reuseExistingServer: !process.env.CI,
          env: { EDGE_PORT: String(PORT), AI_URL: `http://localhost:${AI_PORT}`, WEB_URL },
        },
      ],
});
