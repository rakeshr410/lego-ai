import { messages } from '../index';

// The interview-prep roadmaps (pages/roadmap/index.astro and pages/roadmap/[track].astro), from the
// site header's "Roadmap". The roadmaps' own words (phases, stages, signals, pitfalls) are
// lib/roadmaps.ts; these are the pages' frame.
export default messages({
  title: 'Interview roadmaps',
  description: 'How to prepare for a system design interview, stack by stack: what to learn in what order, the designs to practise on, and how to spend the 45 minutes.',
  heading: 'Prepare for the interview, <accent>stack by stack.</accent>',
  lede: 'A week-by-week plan for each stack: what to learn in what order, which designs to practise on, and how to spend the interview itself.',
  crumb: 'Roadmap',
  /** On a roadmap's card: "6 weeks · 5 phases". */
  'card.meta': '{weeks} weeks · {phases} phases',
  'card.open': 'Read the roadmap',

  'article.description': '{title}: a {weeks}-week preparation plan, how to spend the 45 minutes, and what interviewers listen for.',
  'article.format': 'The interview',
  'article.path': 'Your route',
  /** The route map's two ends. */
  'path.start': 'Today',
  'path.end': 'Interview day',
  /** Over the route map: "6 weeks, 5 phases". */
  'article.pathMeta': '{weeks} weeks, {phases} phases',
  'article.clock': 'The 45 minutes',
  'article.clockLede': 'A way to spend the time that leaves room for the part that’s hard. Practise against it until it feels natural.',
  /** A stage's minutes on the clock: "5 min". */
  'article.minutes': '{n} min',
  /** A stage's place on the clock: "0–5 min". */
  'article.range': '{from}–{to} min',
  'article.signals': 'What interviewers listen for',
  'article.phases': 'Week by week',
  'article.goal': 'Goal',
  'article.learn': 'You’ll be able to explain',
  'article.read': 'Read on Arrowbox',
  'article.soon': 'soon',
  'article.practice': 'Practise',
  'article.check': 'Check yourself',
  'article.pitfalls': 'Common pitfalls',
  'article.next': 'Start with week 1',
  'article.board': 'Open the {track} board',
  'article.others': 'Other roadmaps',
});
