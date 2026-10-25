import { messages } from '../index';

// Reader feedback and privacy choices (P3-2): the section vote bar (SectionFeedback.tsx), the
// report form (ReportDialog.tsx), "Notify me" (NotifyMe.tsx, feedback-client.ts NOTIFY_COPY) and
// the privacy choices banner (ConsentBanner.astro).
export default messages({
  'vote.question': 'Was this section helpful?',
  'vote.up': 'Helpful',
  'vote.down': 'Not helpful',
  'vote.thanks': 'Thanks for letting us know.',
  'vote.thanksDown': 'Thanks. Tell us what’s wrong?',
  'report.open': 'Report an issue',
  'report.sent': 'Report sent. Thank you: an editor will look at it.',

  'report.title': 'Report an issue',
  'report.sub': 'In “{section}”. An editor reads every report.',
  'report.kind': 'What kind of issue?',
  'report.what': 'What’s wrong?',
  'report.hint': { one: 'Please don’t include personal details. # character left.', other: 'Please don’t include personal details. # characters left.' },
  /** The honeypot field's label: people never see it. */
  'report.trap': 'Website',
  'report.tooShort': 'Tell us a little more about what’s wrong.',
  'report.cancel': 'Cancel',
  'report.send': 'Send report',
  'report.sending': 'Sending…',

  /** No email is sent yet, so the wording promises none (P3-2). */
  'notify.ask': 'I want to read this',
  'notify.asked': 'You asked for this',
  'notify.added': 'Noted: it moves up the writing list.',
  'notify.removed': 'Okay, taken off the list.',

  'consent.title': 'Privacy choices',
  'consent.body':
    'Arrowbox keeps only what it needs to work: your sign-in, and your own settings and progress. With your permission it also counts how pages are read, such as which sections get finished and how quick checks go, to decide what to write and fix next. No advertising, no third parties, not linked to your account. <link>Privacy notice</link>',
  'consent.necessary': 'Necessary only',
  'consent.analytics': 'Allow analytics',
  'consent.close': 'Close',
});
