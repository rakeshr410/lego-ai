// lib/sd.ts re-exports these; islands that need only a flag (the account page, sign-in) import
// this small module instead.

/** Build-time switches, read from PUBLIC_* env vars ('true' turns one on). */
export const FLAGS = {
  /** Mock interview entry points and pages. Off until the interview room exists. */
  interview: import.meta.env.PUBLIC_INTERVIEW_ENABLED === 'true',
  /**
   * Ask mode (the AI tutor) and the reader's notes: the reader's switch and notes, its copy on
   * the other pages, and /api/ask*. Off until a later release; with it off none of it is built.
   */
  ask: import.meta.env.PUBLIC_ASK_ENABLED === 'true',
  /**
   * Interactive labs (docs/labs-design.md): /api/labs/* and the sd.lab island's live mode. Off until
   * the runner is deployed; with it off the routes answer 404 and none of it is built into a page.
   * LABS_ENABLED (runtime) is the kill switch in a build with it on.
   */
  labs: import.meta.env.PUBLIC_LABS_ENABLED === 'true',
  /**
   * Agent labs' live model (lib/server/agent-labs/proxy.ts): /api/labs/agent/runs and /model. Off: both
   * answer 404. AGENT_LAB_LIVE_ENABLED (runtime) is the switch in a build with it on.
   */
  agentLabs: import.meta.env.PUBLIC_AGENT_LABS_ENABLED === 'true',
  /**
   * Early access (docs/interview/README.md "Rollout"): the systems with a mock interview, as slugs
   * (PUBLIC_INTERVIEW_SYSTEMS, comma-separated). Empty: every system with a published plan. A page,
   * an entry point and a plan exist only for the listed systems (interviewSystemOpen below).
   */
  interviewSystems: String(import.meta.env.PUBLIC_INTERVIEW_SYSTEMS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Only topics with reviewStatus 'reviewed' are listed as readable and prerendered. */
  reviewedOnly: import.meta.env.PUBLIC_REVIEWED_ONLY === 'true',
  /**
   * Billing (Phase 4): the Pricing link in the site header, the checkout pages and the account's
   * billing section, and the free tier (lib/server/entitlements.ts freeTierEnforced). With it off
   * none of them is built; BILLING_ENABLED (runtime) is the kill switch for checkout in a build
   * with it on.
   */
  billing: import.meta.env.PUBLIC_BILLING === 'true',
  /**
   * "Continue with Google" on the sign-in and sign-up forms, beside email and password. The server
   * needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET too (lib/server/google.ts); without them the
   * button's route answers 404.
   */
  google: import.meta.env.PUBLIC_GOOGLE_SIGNIN === 'true',
  /** "My dashboard" in the site header and footer, for signed-in readers (design 16b). On unless set to 'false'. */
  dashboardLink: import.meta.env.PUBLIC_DASHBOARD_LINK !== 'false',
  /** What readers say: the reviews column beside the plans on the pricing page. Hidden unless 'true'. */
  pricingReviews: import.meta.env.PUBLIC_PRICING_REVIEWS === 'true',
};

/** Whether this system's mock interview is in the build (every system, or the early-access list). */
export const interviewSystemOpen = (system: string) => FLAGS.interviewSystems.length === 0 || FLAGS.interviewSystems.includes(system);
