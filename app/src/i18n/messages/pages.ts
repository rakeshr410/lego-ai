import { messages } from '../index';

// The server-rendered pages' own text: layouts, the footer, the 404 page, the system hubs, the
// topic article's frame (Article.astro) and every page's title and description. Rendered at build
// time, so none of it reaches the browser's JavaScript.
/**
 * Whether the build has Ask mode (PUBLIC_ASK_ENABLED, deferred to a later release). A literal
 * comparison after Vite's define: a build keeps only the wording for its own case.
 */
const ASK = import.meta.env.PUBLIC_ASK_ENABLED === 'true';

export default messages({
  skip: 'Skip to content',
  /** Every page's <title> ends with the site's name. */
  'meta.title': '{title} · Arrowbox',
  'meta.ogImageAlt': 'Arrowbox: system design, one decision at a time',
  /** How a system is named everywhere but its logo: "Instagram-style app". */
  'system.name': '{name}-style app',
  'notice': 'Illustrative design, not {system}’s actual implementation. Arrowbox is not affiliated with {system}’s owner. <link>Disclaimer</link>',

  /** The site header (components/SiteHeader.astro, design 13a). */
  'header.home': 'Arrowbox home',
  'header.systems': 'Systems',
  'header.roadmap': 'Roadmap',
  'header.faq': 'FAQs',
  'header.interviews': 'Mock interviews',
  'header.pricing': 'Pricing',
  'header.account': 'Account',
  /** Signed in, the header (SiteHeader.astro) links to the dashboard and opens the account menu. */
  'header.menu.dashboard': 'My dashboard',
  /** The account menu (design 16b): the button's name, the plan row and the items. */
  'header.menu.label': 'Account menu',
  'header.menu.plan': '{plan} plan',
  'header.menu.upgrade': 'Upgrade',
  'header.menu.settings': 'Settings',
  'header.menu.signOut': 'Sign out',
  /** The keys that open the dashboard from anywhere: G, then D. */
  'header.menu.shortcut': 'G then D',

  'footer.nav': 'Legal',
  /** The footer's closing call to action and link columns (design 14a). */
  'footer.cta.title': 'Not sure where to start?',
  'footer.cta.text': 'Pick a stack and follow its week-by-week plan.',
  'footer.cta.roadmaps': 'See the roadmaps',
  'footer.cta.systems': 'Browse systems',
  'footer.tagline': 'System design, one question at a time, split into parts you can finish.',
  'footer.stacks': 'Stacks',
  'footer.learn': 'Learn',
  'footer.brand': 'Arrowbox',
  'footer.systems': 'Systems',
  'footer.roadmaps': 'Roadmaps',
  'footer.dashboard': 'My dashboard',
  'footer.pricing': 'Pricing',
  'footer.faq': 'FAQs',
  'footer.contactShort': 'Contact',
  'footer.copyright': '© {year} Arrowbox',
  'footer.contact': 'Contact and takedown requests',
  'footer.privacyChoices': 'Privacy choices',
  'legal.crumb': 'Legal',
  'legal.nav': 'Legal pages',
  'legal.terms': 'Terms',
  'legal.privacy': 'Privacy',
  'legal.refunds': 'Refunds',
  'legal.disclaimer': 'Disclaimer',
  /** Shown in the footer and on the disclaimer page. */
  'legal.brandNotice':
    'Arrowbox is an independent educational resource. Product names are trademarks of their respective owners and are used only to identify the kind of system discussed. Arrowbox is not affiliated with or endorsed by them. Designs are illustrative and do not describe any company’s actual implementation.',
  'draft.title': 'Draft — requires legal review',
  'draft.text':
    'This page is placeholder text. It is not a statement of Arrowbox’s terms or practices until it has been reviewed and approved by counsel. Items in brackets are open decisions.',

  'notFound.title': 'Page not found',
  'notFound.description': 'There’s nothing at this address.',
  'notFound.code': 'Error 404 · No sheet at this address',
  'notFound.text': 'There’s nothing at this address. It may have moved, or the topic may not be published yet.',
  'notFound.links': '<library>Browse the system library</library> or go to the <home>home page</home>.',
  'notFound.systems': 'Systems with topics to read',

  'library.name': 'System design library',
  'library.description': 'Illustrative system designs for {count} kinds of everyday apps, from photo sharing to chat. Pick an app, then a topic to read.',

  'hub.title': '{name} · System design · Arrowbox',
  /** A hub's description, whole sentences per case: {example} is the system's kind, lower-cased ("photo sharing"). */
  'hub.description': {
    one: 'Illustrative system design for a {example} app like {name}: # topic to read, from requirements to deep dives.',
    other: 'Illustrative system design for a {example} app like {name}: # topics to read, from requirements to deep dives.',
  },
  'hub.descriptionPlain': {
    one: 'Illustrative system design for an app like {name}: # topic to read, from requirements to deep dives.',
    other: 'Illustrative system design for an app like {name}: # topics to read, from requirements to deep dives.',
  },
  'hub.descriptionWriting': 'Illustrative system design for a {example} app like {name}: topics are being written.',
  'hub.descriptionWritingPlain': 'Illustrative system design for an app like {name}: topics are being written.',
  'hub.start': 'Start with {title}',
  'hub.updated': 'Updated {date}',
  'hub.minutes': '{minutes} min read',
  'hub.ready': 'Ready',

  'topic.title': '{topic} · {system} · Arrowbox',
  'article.reviewed': 'Reviewed',
  /** The link at the right of the topic's breadcrumb row. */
  /** On a system's read page: which topic of how many. */
  'read.crumb': 'Read',
  /** The read page's title: "Designing a customer support agent". */
  'read.title': 'Designing {name}',
  'read.overview': 'In this article',
  'read.overviewPart': 'Part {n}: {title}',
  'article.part': 'Part {n} of {total}',
  'article.disclaimer': 'Disclaimer',
  'article.updated': 'Updated {date}',
  /** An agentic topic's pattern and autonomy (its agentProfile), as header chips (design 19b). */
  'article.pattern': 'Pattern: {pattern}',
  'article.autonomy': 'Autonomy: {autonomy}',
  /** The topic's prerequisites (P3-4): <list> is the linked titles, joined with the two below. */
  'article.before': 'Builds on <list>these topics</list>.',
  'article.beforeSep': ', ',
  'article.beforeLast': ' and ',
  /**
   * A topic's Free variant (Phase 4, decision 2; components/sd/LockedSection.astro): the panel
   * where locked sections start. It promises only what the gate enforces. <list> is the designs
   * pricing.yaml gives Free readers in full, linked and joined like article.before.
   */
  'locked.eyebrow': 'Pro',
  'locked.title': 'The rest of this design is in Pro.',
  'locked.text': 'Your Free plan opens the functional requirements of every design, and <list>these designs</list> in full. Pro opens every section of every design.',
  'locked.textNoFull': 'Your Free plan opens the functional requirements of every design. Pro opens every section of every design.',
  'locked.section': 'This section is in Pro.',
  'locked.cta': 'See plans',

  'signin.title': 'Sign in · Arrowbox',
  'signin.description': ASK ? 'Sign in to keep your Ask notes and progress.' : 'Sign in to keep your reading progress.',
  'reset.title': 'Reset password · Arrowbox',
  'interview.title': 'Mock interview · {topic} · Arrowbox',
  'interview.description': 'A 1:1 mock system design interview on {topic}.',
});
