import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, readableTopics, test } from './fixtures';

// The mock interview (P3-11, docs/README.md), end to end against the mocked Anthropic API
// (e2e/mock-anthropic.mjs), through the edge router with the main site (playwright.config.ts).
// Which half runs depends on the build under test:
//
//   PUBLIC_INTERVIEW_ENABLED unset (the default build): no page and no API.
//   PUBLIC_INTERVIEW_ENABLED=true (build and test with it): sign up, open the system's interview
//   from the reader, consent, answer, move on, end, read the feedback, delete the session.
//
// Needs registration without email confirmation, like auth.spec.ts.

const ON = process.env.PUBLIC_INTERVIEW_ENABLED === 'true';
const MOCK = `http://127.0.0.1:${process.env.MOCK_ANTHROPIC_PORT ?? 4410}`;
// The system with a plan (content/interviews/instagram.yaml) and one of its readable topics.
const SYSTEM = 'instagram';
const reader = readableTopics.find((t) => t.system === SYSTEM)!;
const readerPath = `/systems/${SYSTEM}/${reader.slug}`;
const interviewPath = `/systems/${SYSTEM}/interview`;

const BLOCKING = new Set(['serious', 'critical']);
async function noSeriousAxe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(
    violations.filter((v) => BLOCKING.has(v.impact ?? '')).map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    `${label}: serious or critical axe violations`,
  ).toEqual([]);
}

test.describe('mock interview, flag off (the default build)', () => {
  test.skip(ON, 'this build has PUBLIC_INTERVIEW_ENABLED=true');

  // This app's half: no page and no API. That the main site's reader pages offer no entry point
  // is the main site's own spec (lego/web/e2e/interview-links.spec.ts).
  test('has no page and no API', async ({ request, signIn }) => {
    await signIn();
    expect((await request.get(interviewPath)).status()).toBe(404);
    expect((await request.get(`/api/interview?system=${SYSTEM}`)).status()).toBe(404);
  });
});

test.describe('mock interview, flag on', () => {
  test.skip(!ON, 'build and run with PUBLIC_INTERVIEW_ENABLED=true');
  test.skip(process.env.E2E_SKIP_AUTH === '1', 'E2E_SKIP_AUTH=1');
  test.skip(!!process.env.E2E_BASE_URL, 'needs the local mock Anthropic API');
  // A client address of its own (the test server trusts one proxy hop, TRUST_PROXY=1): CI runs this
  // right after the other specs' sign-ups, and registration allows 5 per address per 10 minutes.
  test.use({ extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.23' } });

  const id = `e2eiv${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const account = { username: id, email: `${id}@e2e.arrowbox.test`, password: `pw-${id}-Secret!` };

  test('from the reader to written feedback', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.request.post(`${MOCK}/__reset`);
    let registered = false;
    try {
      await test.step('the landing page asks a visitor to sign in', async () => {
        await page.goto(interviewPath);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Sign in to start' })).toBeVisible();
        await noSeriousAxe(page, 'landing, signed out');
      });

      await test.step('sign up', async () => {
        await page.goto(`/signin?next=${encodeURIComponent(interviewPath)}`);
        await page.getByRole('button', { name: 'New here? Create an account' }).click();
        await page.getByLabel('Username').fill(account.username);
        await page.getByLabel('Email').fill(account.email);
        await page.getByLabel('Password').fill(account.password);
        await page.getByRole('button', { name: 'Create account' }).click();
        await page.waitForURL(`**${interviewPath}`);
        registered = true;
      });

      await test.step('the reader links to the system’s interview', async () => {
        await page.goto(readerPath);
        const link = page.getByRole('link', { name: 'Start interview' });
        await expect(link).toHaveAttribute('href', interviewPath);
        await link.click();
        await page.waitForURL(`**${interviewPath}`);
      });

      await test.step('consent, then start', async () => {
        await page.getByRole('button', { name: 'Start interview' }).click();
        const start = page.getByRole('button', { name: 'Agree and start' });
        await expect(start).toBeDisabled();
        await page.getByLabel('I understand and agree').check();
        await noSeriousAxe(page, 'landing, consent');
        await start.click();
        const log = page.getByRole('log', { name: 'Interview transcript' });
        await expect(log).toContainText('design the web client of a photo-sharing app');
        // Starting costs nothing: the opener is written in the plan.
        expect(await (await page.request.get(`${MOCK}/__requests`)).json()).toEqual([]);
      });

      const log = page.getByRole('log', { name: 'Interview transcript' });

      await test.step('answer and get the interviewer’s streamed reply', async () => {
        await page.getByLabel('Your answer').fill('Who are the users, and which devices matter most?');
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(log).toContainText('Mock tutor answer');
        await expect(page.getByLabel('Your answer')).toHaveValue('');
        const calls = (await (await page.request.get(`${MOCK}/__requests`)).json()) as { model: string; stream?: boolean }[];
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ model: 'claude-sonnet-5', stream: true });
        await noSeriousAxe(page, 'room');
      });

      await test.step('move on to the next stage', async () => {
        await page.getByRole('button', { name: 'Next stage →' }).click();
        await expect(log).toContainText('Stage 2 of 4 begins');
        await expect(page.getByText('Stage 2 of 4', { exact: true })).toBeVisible();
      });

      await test.step('end and read the feedback', async () => {
        await page.getByRole('button', { name: 'End interview' }).click();
        await page.getByRole('button', { name: 'End and get feedback' }).click();
        const feedback = page.getByRole('region', { name: 'Feedback' });
        await expect(feedback).toContainText('Mock feedback');
        await expect(feedback).toContainText('Solid');
        await noSeriousAxe(page, 'feedback');
      });

      await test.step('delete the session', async () => {
        await page.getByRole('button', { name: 'Delete this session now' }).click();
        await expect(page.getByRole('button', { name: 'Start interview' })).toBeVisible();
        await expect(page.getByText('Past sessions')).toHaveCount(0);
      });
    } finally {
      if (registered) {
        const res = await page.request.delete('/api/account', { data: { confirm: 'DELETE' }, headers: { Origin: baseURL! } });
        expect(res.ok()).toBe(true);
      }
    }
  });
});

test.describe('the interview room page’s policy', () => {
  test.skip(!ON, 'build and run with PUBLIC_INTERVIEW_ENABLED=true');
  const BOARD = process.env.PUBLIC_INTERVIEW_BOARD_ENABLED === 'true';

  // The whiteboard's canvas creates a worker from a blob URL: its page, and only its page, allows
  // that (roomCsp, docs/README.md "Whiteboard"); a build without the board keeps the
  // site's policy everywhere.
  test(`allows a blob worker on the room page ${BOARD ? 'with' : 'and nowhere else without'} the board`, async ({ request }) => {
    const res = await request.get(interviewPath);
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'] ?? res.headers()['content-security-policy-report-only'] ?? '';
    if (BOARD) expect(csp).toContain("worker-src 'self' blob:");
    else expect(csp).not.toContain('worker-src');
    const other = (await request.get('/')).headers()['content-security-policy'] ?? '';
    expect(other).not.toContain('blob:');
  });
});
