import { readFileSync } from 'node:fs';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

type SeedTopic = { system: string; slug: string; title: string; content?: unknown[]; coachTips?: { target: string }[] };
type Seed = { systems: { slug: string; name: string }[]; topics: SeedTopic[] };

const seed = JSON.parse(readFileSync(new URL('../../../lego/cms/data/system-design.json', import.meta.url), 'utf8')) as Seed;

/** The first seeded topic with content: it is built as a reader page. */
export const topic = (() => {
  const t = seed.topics.find((x) => x.content?.length);
  if (!t) throw new Error('no seeded topic has content');
  const system = seed.systems.find((s) => s.slug === t.system)!;
  return { ...t, systemName: system.name, path: `/systems/${t.system}/${t.slug}` };
})();

/**
 * Whether the server under test was built with Ask mode (PUBLIC_ASK_ENABLED=true; off by default
 * until a later release). Set the same variable when running the specs against such a build.
 */
export const ASK_ON = process.env.PUBLIC_ASK_ENABLED === 'true';

/**
 * Whether the server under test was built with billing (PUBLIC_BILLING=true; off by default until
 * Phase 4 launches): the pricing page and its links. Set the same variable when running the specs
 * against such a build.
 */
export const BILLING_ON = process.env.PUBLIC_BILLING === 'true';
/** Whether the build shows "My dashboard" in the header (on unless PUBLIC_DASHBOARD_LINK=false). */
export const DASHBOARD_LINK_ON = process.env.PUBLIC_DASHBOARD_LINK !== 'false';

/** Every seeded system (each has a hub page) and every topic with content (each has a reader page). */
export const seedSystems = seed.systems;
export const readableTopics = seed.topics.filter((t) => t.content?.length);

export type Account = { username: string; email: string; password: string };

/** A new reader's details; `prefix` says which spec made it. */
export function newAccount(prefix = 'e2e'): Account {
  const id = `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  return { username: id, email: `${id}@e2e.arrowbox.test`, password: `pw-${id}-Secret!` };
}

/** Deletes a signed-in account (the request context carries its session). */
export async function deleteAccount(request: APIRequestContext, origin: string) {
  const res = await request.delete('/api/account', { data: { confirm: 'DELETE' }, headers: { Origin: origin } });
  expect(res.status(), 'deleting the test account').toBe(204);
}

// Topic pages are for signed-in readers (src/lib/gated.ts). Each spec file signs up one reader,
// from its own client address (below), the first time one of its tests calls signIn(); later
// tests sign that reader in again. The worker deletes the accounts when it is done.
const readers = new Map<string, { account: Account; ip: string }>();
const skipAuth = process.env.E2E_SKIP_AUTH === '1';

// The reader's one-time tips (Coach) float over controls; mark them all as seen.
const coachTargets = [...new Set(seed.topics.flatMap((t) => t.coachTips ?? []).map((t) => t.target))];

/**
 * Fails a test on uncaught page errors and on Content-Security-Policy violations, which only
 * show up as console errors.
 */
export const test = base.extend<
  {
    pageErrors: string[];
    noCoachTips: void;
    noCouponPopup: void;
    consent: 'necessary' | 'analytics' | 'unset';
    consentChoice: void;
    /**
     * Signs `page` (default: the test's page) in as this spec file's reader, signing one up the
     * first time; returns the account. Topic pages need it. Skips the test with E2E_SKIP_AUTH=1.
     */
    signIn: (page?: Page) => Promise<Account>;
    /** `test.use({ signedIn: true })`: every test in the block starts signed in (signIn above). */
    signedIn: boolean;
    autoSignIn: void;
  },
  { readerCleanup: void }
>({
  /**
   * A client address per spec file (the test server trusts one proxy hop, TRUST_PROXY=1): the whole
   * suite signs up more accounts than registration allows one address in 10 minutes (5), so each
   * file registers from its own. A spec's own `x-forwarded-for` (interview.spec.ts) wins.
   */
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, info) => {
    let h = 0;
    for (const c of info.file) h = (h * 31 + c.charCodeAt(0)) % 250;
    await use({ 'x-forwarded-for': `198.51.100.${h + 1}`, ...extraHTTPHeaders });
  },
  signIn: async ({ page, baseURL, extraHTTPHeaders }, use, info) => {
    await use(async (target = page) => {
      info.skip(skipAuth, 'E2E_SKIP_AUTH=1: topic pages need a signed-in reader');
      const origin = new URL(baseURL!).origin;
      const headers = { Origin: origin };
      let reader = readers.get(info.file);
      if (!reader) {
        const account = newAccount('e2eread');
        const res = await target.request.post('/api/auth/register', { data: account, headers });
        expect(res.status(), `signing up the spec's reader: ${await res.text()}`).toBe(200);
        reader = { account, ip: extraHTTPHeaders?.['x-forwarded-for'] ?? '' };
        readers.set(info.file, reader);
      } else {
        const res = await target.request.post('/api/auth/login', { data: { identifier: reader.account.email, password: reader.account.password }, headers });
        expect(res.status(), `signing the spec's reader in: ${await res.text()}`).toBe(200);
      }
      return reader.account;
    });
  },
  signedIn: [false, { option: true }],
  autoSignIn: [
    async ({ signedIn, signIn }, use) => {
      if (signedIn) await signIn();
      await use();
    },
    { auto: true },
  ],
  readerCleanup: [
    async ({ playwright }, use, workerInfo) => {
      await use();
      const baseURL = workerInfo.project.use.baseURL!;
      for (const { account, ip } of readers.values()) {
        const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: ip ? { 'x-forwarded-for': ip } : {} });
        try {
          const origin = new URL(baseURL).origin;
          const login = await request.post('/api/auth/login', { data: { identifier: account.email, password: account.password }, headers: { Origin: origin } });
          if (login.ok()) await deleteAccount(request, origin);
        } finally {
          await request.dispose();
        }
      }
      readers.clear();
    },
    { scope: 'worker', auto: true },
  ],
  /**
   * The reader's privacy choice (P3-2) before the page loads: "necessary only" by default, so the
   * banner never covers what a test clicks. `test.use({ consent: 'unset' })` shows the banner.
   */
  consent: ['necessary', { option: true }],
  consentChoice: [
    async ({ page, consent }, use) => {
      if (consent !== 'unset') {
        await page.addInitScript((analytics) => {
          try {
            if (!localStorage.getItem('sd-consent')) localStorage.setItem('sd-consent', JSON.stringify({ v: 1, analytics, at: new Date().toISOString() }));
          } catch {
            /* storage blocked */
          }
        }, consent === 'analytics');
      }
      await use();
    },
    { auto: true },
  ],
  noCoachTips: [
    async ({ page }, use) => {
      await page.addInitScript((targets) => {
        try {
          localStorage.setItem('sd-coach-done', JSON.stringify(targets));
        } catch {
          /* storage blocked */
        }
      }, coachTargets);
      await use();
    },
    { auto: true },
  ],
  /**
   * The pricing page's coupon pop-up (lib/pricing-client.ts) counts as already shown, so it never
   * covers what a test clicks. Its own spec turns it back on.
   */
  noCouponPopup: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        try {
          sessionStorage.setItem('sd-coupon-popup', '1');
        } catch {
          /* storage blocked */
        }
      });
      await use();
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) errors.push(`csp: ${m.text()}`);
      });
      await use(errors);
      expect(errors, 'page errors').toEqual([]);
    },
    { auto: true },
  ],
});

type QuizTopic = { system: string; slug: string; content?: unknown[] };

/**
 * Reads the first section that has a quiz, the way a reader does (P3-1, components/sd/reading.ts):
 * with its end on screen for as long as it takes (the page's clock is run forward), then moves on
 * to the next section, which offers the quiz.
 */
export async function readSectionWithQuiz(page: Page, t: QuizTopic): Promise<number> {
  const kinds = (t.content ?? []).map((b) => (b as { __component?: string }).__component);
  let section = -1;
  let withQuiz = -1;
  for (const k of kinds) {
    if (k === 'sd.section') section++;
    else if (k === 'sd.quiz' && withQuiz < 0) withQuiz = section;
  }
  await page.clock.install();
  await page.goto(`/systems/${t.system}/${t.slug}`);
  await page.waitForLoadState('networkidle');
  // The section current, with its end on screen: its top above the reader's line, or its bottom in view.
  await page.evaluate((i) => {
    const s = document.querySelectorAll<HTMLElement>('section.rd-section')[i];
    const r = s.getBoundingClientRect();
    const top = r.top + window.scrollY;
    window.scrollTo(0, Math.max(top - 150, top + r.height - window.innerHeight + 20));
  }, withQuiz);
  await page.clock.runFor(65_000);
  await page.evaluate((i) => {
    const next = document.querySelectorAll<HTMLElement>('section.rd-section')[i + 1];
    window.scrollTo(0, next.getBoundingClientRect().top + window.scrollY - 100);
  }, withQuiz);
  await page.clock.runFor(3_000);
  return withQuiz;
}

/**
 * Hydrates every island on the page: interactive blocks hydrate as they come near the viewport
 * (client:visible, P3-5), so each one still waiting is scrolled to in turn. The page is scrolled
 * back to where it was.
 */
export async function hydrateAll(page: Page) {
  const top = await page.evaluate(() => window.scrollY);
  await expect(async () => {
    await page.evaluate(async () => {
      for (const island of document.querySelectorAll('astro-island[ssr]')) {
        // Islands and slots are display: contents, with no box of their own to scroll to: scroll to
        // the island's own first drawn element (a section's vote bar sits at its end, the next-topic
        // card after the last section), else to the block or section around it.
        const own = [...island.children].find((c) => c.getClientRects().length > 0);
        (own ?? island.closest('.rd-block, section, main'))?.scrollIntoView({ block: 'center' });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    });
    await expect(page.locator('astro-island[ssr]')).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.evaluate((y) => window.scrollTo(0, y), top);
}

export { expect };
