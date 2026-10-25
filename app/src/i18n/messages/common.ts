import { messages } from '../index';

// Words more than one part of the interface uses: the site's navigation and a few labels.
export default messages({
  'nav.primary': 'Primary',
  'nav.breadcrumb': 'Breadcrumb',
  'nav.home': 'Home',
  'nav.library': 'Library',
  signIn: 'Sign in',
  /** Links into a topic for a signed-out reader (topic pages are for signed-in readers): a hint and a button. */
  signInToRead: 'Sign in to read',
  signInToStart: 'Sign in to start reading',
  close: 'Close',
  comingSoon: 'Coming soon',
  /** Stands in for a content block that failed to render (ErrorBoundary.tsx): here, not in blocks.ts, because the reader's chrome loads it. */
  blockFallback: 'This part of the page couldn’t be shown.',
  /** A topic's reading time, on chips and the picker's rows. */
  minutes: '{minutes} min',
  /** A topic's difficulty (P3-4), on its page's chips, the hub, the picker and search. */
  'difficulty.beginner': 'Beginner',
  'difficulty.intermediate': 'Intermediate',
  'difficulty.advanced': 'Advanced',
});
