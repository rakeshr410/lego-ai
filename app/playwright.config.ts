import { defineConfig, devices } from '@playwright/test';
import { MOCK_KEYS } from './e2e/mock-razorpay.mjs';

// Browser smoke tests against the BUILT web server (`npm run build` first) with the Anthropic
// API and Razorpay mocked (e2e/mock-anthropic.mjs, e2e/mock-razorpay.mjs): no test ever calls
// either for real, and the server gets the mock's fake Razorpay keys whatever the shell holds.
// For the billing pages, build with PUBLIC_BILLING=true and
// PUBLIC_RAZORPAY_CHECKOUT_URL=http://127.0.0.1:<MOCK_RAZORPAY_PORT>/checkout.js (the pop-up's
// script is fixed at build time); BILLING_ENABLED then defaults to true. Strapi and Redis must
// already be running:
//
//   STRAPI_URL=http://localhost:1337 REDIS_URL=redis://localhost:6379 STRAPI_SERVER_TOKEN=... npm run test:e2e
//
// Set E2E_BASE_URL to test a server you started yourself (e.g. a staging deploy behind its
// proxy); nothing is started then. Strapi needs EMAIL_CONFIRMATION=false for the auth test.

const PORT = Number(process.env.E2E_PORT ?? 4400);
const MOCK_PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4410);
const RAZORPAY_PORT = Number(process.env.MOCK_RAZORPAY_PORT ?? 4420);
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
          command: 'node e2e/mock-razorpay.mjs',
          url: `http://127.0.0.1:${RAZORPAY_PORT}/health`,
          reuseExistingServer: !process.env.CI,
          env: { MOCK_RAZORPAY_PORT: String(RAZORPAY_PORT), MOCK_RAZORPAY_WEBHOOK_URL: `${baseURL}/api/billing/webhook` },
        },
        {
          command: 'node scripts/serve.ts',
          url: `${baseURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          stdout: 'pipe',
          env: {
            ...(process.env as Record<string, string>),
            HOST: '0.0.0.0',
            PORT: String(PORT),
            // A production build: it needs the same settings a deploy does.
            PUBLIC_ORIGIN: baseURL,
            TRUST_PROXY: process.env.TRUST_PROXY ?? '1',
            REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
            STRAPI_URL: process.env.STRAPI_URL ?? 'http://localhost:1337',
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
            ANTHROPIC_API_KEY: 'e2e-mock-anthropic-key-not-a-secret',
            // Ask's runtime switch on (it is off by default): in a build with PUBLIC_ASK_ENABLED=true
            // the Ask specs need it, and in the default build ask.spec.ts checks that Ask's API
            // is still a 404 with it on. The mock interview's calls pass it too.
            ASK_ENABLED: process.env.ASK_ENABLED ?? 'true',
            LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
            // Billing against the mock Razorpay, in test mode, with its fake keys (never real ones).
            BILLING_ENABLED: process.env.BILLING_ENABLED ?? process.env.PUBLIC_BILLING ?? 'false',
            BILLING_MODE: 'test',
            // A production build refuses test mode without this (lib/server/env.ts); only staging and these specs set it.
            BILLING_ALLOW_TEST: 'true',
            RAZORPAY_API_BASE: `http://127.0.0.1:${RAZORPAY_PORT}`,
            RAZORPAY_KEY_ID: MOCK_KEYS.keyId,
            RAZORPAY_KEY_SECRET: MOCK_KEYS.keySecret,
            RAZORPAY_WEBHOOK_SECRET: MOCK_KEYS.webhookSecret,
            RAZORPAY_WEBHOOK_SECRET_PREV: '',
            // No background reconciler: the specs hold and deliver the mock's webhooks themselves, and
            // a sweep landing mid-test would make them race (its unit tests are in billing/).
            BILLING_RECONCILE_INTERVAL_MS: process.env.BILLING_RECONCILE_INTERVAL_MS ?? '0',
          },
        },
      ],
});
