import { messages } from '../index';

// What the /api/* routes tell people (the `error` or `message` of a JSON answer), which the
// sign-in form and Ask mode show as they come. Server-only. Errors meant for developers
// ("Forbidden", "Unknown topic") are not interface text and stay in the routes.
export default messages({
  'auth.checkEmail': 'If that address can use Arrowbox, we’ve sent it an email. Check your inbox (and spam folder) for the link.',
  'auth.missing': 'Enter your email or username and password.',
  'auth.unconfirmed': 'Confirm your email address first. We sent you a link when you signed up.',
  'auth.blocked': 'This account can’t sign in right now. Contact support if you think this is a mistake.',
  'auth.mismatch': 'That email/username and password don’t match.',
  'auth.username': 'Choose a username of 3–30 letters, numbers, dots, dashes or underscores.',
  'auth.email': 'Enter a valid email address.',
  'auth.password': 'Use a password of at least {min} characters.',
  'auth.human': 'Please complete the human check and try again.',
  'auth.signupsPaused': 'Sign-ups are paused for today. Please try again tomorrow.',
  'auth.registerFailed': 'Couldn’t create that account. Check the details and try again.',
  'auth.resetInvalid': 'This reset link is invalid. Request a new one.',
  'auth.resetExpired': 'This reset link has expired or was already used. Request a new one.',
  'auth.resetFailed': 'Couldn’t set that password. Try a different one.',
  'unavailable.signin': 'Sign-in is unavailable right now. Try again shortly.',
  'unavailable.register': 'Registration is unavailable right now. Try again shortly.',
  'unavailable.reset': 'Password reset is unavailable right now. Try again shortly.',
  /** The account page's routes (P3-8). */
  'unavailable.account': 'Your account is unavailable right now. Try again shortly.',
  'unavailable.email': 'Changing your email is unavailable right now. Try again shortly.',
  'unavailable.confirmEmail': 'Confirming your email is unavailable right now. Try again shortly.',
  'unavailable.password': 'Changing your password is unavailable right now. Try again shortly.',
  /** The sign-in queue is full, or the call took too long (503 + Retry-After). */
  'busy.signin': 'Sign-in is busy right now. Try again in a few seconds.',
  'busy.register': 'Registration is busy right now. Try again in a few seconds.',
  'busy.reset': 'Password reset is busy right now. Try again in a few seconds.',
  'busy.account': 'Your account is busy right now. Try again in a few seconds.',
  'busy.email': 'Changing your email is busy right now. Try again in a few seconds.',
  'busy.confirmEmail': 'Confirming your email is busy right now. Try again in a few seconds.',
  'busy.password': 'Changing your password is busy right now. Try again in a few seconds.',

  'limit.default': 'Too many attempts. Try again in a minute.',
  'limit.upstream': 'Too many attempts right now. Try again in a minute.',
  'limit.attempts': 'Too many attempts. Try again later.',
  'limit.requests': 'Too many requests. Try again later.',
  'limit.requestsMinute': 'Too many requests. Try again in a minute.',
  'limit.signups': 'Too many sign-ups from this network. Try again later.',
  'limit.account': 'Too many failed attempts for this account. Try again later.',
  'limit.ask': 'Too many requests. Give it a minute.',
  'limit.notes': 'Too many changes. Give it a minute.',
  'limit.questions': 'That’s a lot of questions. Give it a minute.',

  'ask.signIn': 'Sign in to ask questions.',
  'ask.length': 'Ask a question of up to {max} characters.',
  'ask.noteFull': 'A note holds up to {max} questions. Start a new one.',
  'ask.upstream': 'I couldn’t reach the answer service just now. Try asking again in a moment.',
  'ask.disabled': 'Ask is paused right now. Your notes are still here; try again later.',
  'ask.budget': 'Ask has reached its limit for today. It will be back tomorrow.',
  'ask.quota': 'You’ve used today’s questions.',
  'ask.busy': 'Ask is busy right now. Try again in a moment.',
  'ask.timeout': 'That took too long to answer. Try asking again.',
  'ask.aborted': 'The question was cancelled.',
  'ask.unavailable': 'Ask is temporarily unavailable. Try again later.',
  'ask.failed': 'I couldn’t get an answer just now. Try asking again in a moment.',
  'notes.signIn': 'Sign in to keep notes.',
  'notes.tooLong': 'Nothing to save (notes are limited to {max} characters).',
  'notes.unavailable': 'Notes are unavailable right now. Try again in a moment.',
  'notes.pageFull': 'You can keep up to {max} notes on a page. Delete one to add another.',
  'notes.readerFull': 'You can keep up to {max} notes. Delete some to add more.',

  'account.signInDelete': 'Sign in to delete your account.',
  'account.deleteFailed': 'We couldn’t finish deleting your account. Contact support and we’ll complete it.',
  /** Deleting stops before anything is deleted when the subscription can't be cancelled first (Phase 4 §4.7). */
  'account.deleteBilling': 'We couldn’t cancel your subscription, so nothing was deleted. Try again in a minute.',
  'account.deleteBillingSent': 'We started cancelling your subscription but couldn’t finish, so nothing was deleted yet. Try again in a minute.',
  'account.signInExport': 'Sign in to export your data.',
  'account.exportFailed': 'Export is unavailable right now. Try again shortly.',
  /** A topic page asked for without a session (lib/server/gate.ts): fetches get this, pages redirect. */
  'gate.signIn': 'Sign in to read this topic.',
  'gate.unavailable': 'We can’t check your sign-in right now. Try again in a moment.',

  /**
   * The billing routes' errors (Phase 4, docs/phase-4-design.md §5), by BillingError code
   * (lib/server/billing/route.ts). The checkout page shows them as they come, except where it has
   * a state of its own (already on Pro, a payment issue, checkout paused).
   */
  'billing.signin': 'Sign in to buy Pro.',
  'billing.bad_request': 'That request isn’t one checkout understands. Reload the page and try again.',
  'billing.invalid_address': 'Check the highlighted parts of your billing address.',
  'billing.consent_required': 'Agree to the renewal terms before paying.',
  'billing.country_unavailable': 'Checkout in US dollars opens soon. For now Pro can be bought with a billing address in India.',
  'billing.quote_changed': 'The price was updated. Check the new total, then press Pay again.',
  'billing.invalid_coupon': 'That code isn’t valid. Check it, or continue without one.',
  'billing.couponTries': 'Too many codes tried. Try again tomorrow, or continue without one.',
  'billing.already_pro': 'You’re already on Pro.',
  'billing.payment_issue': 'Your last renewal didn’t go through, so a new subscription can’t start yet.',
  'billing.checkout_busy': 'Your checkout is already being set up. Try again in a few seconds.',
  'billing.gateway': 'The payment service didn’t answer. Nothing was charged; try again in a minute.',
  'billing.billing_disabled': 'Checkout is paused right now. Nothing was charged; try again later.',
  'billing.not_found': 'We can’t find that checkout.',
  'billing.bad_signature': 'That payment couldn’t be confirmed. If you were charged, contact support with your REF.',
  'billing.mismatch': 'This card can’t pay in rupees. The payment is being refunded.',
  'billing.unavailable': 'Billing is unavailable right now. Nothing was charged; try again shortly.',
  /** The account's Billing section (/api/billing, /cancel, /fix-payment; Phase 4 §4.5). */
  'billing.no_subscription': 'You don’t have a subscription to change.',
  'billing.already_cancelling': 'Your subscription is already set to end. It won’t renew.',
  'billing.no_issue': 'Your subscription’s payments are up to date: there’s nothing to fix.',
  'billing.manage.gateway': 'The payment service didn’t answer, so nothing changed. Try again in a minute.',
  'billing.manage.disabled': 'Subscription changes are paused right now, so nothing changed. Try again later.',
  'billing.manage.busy': 'Your subscription is being updated. Try again in a few seconds.',
  'billing.manage.unavailable': 'Billing is unavailable right now, so nothing changed. Try again shortly.',
  'billing.manage.sent': 'Your change reached the payment service, but we couldn’t confirm it yet. Refresh in a minute to see it.',

  /** The processing and confirmation pages' routes (/api/billing/status, /receipt; Phase 4, 14b and 14c). */
  'billing.status.signIn': 'Sign in to see your payment.',
  'billing.status.notFound': 'We couldn’t find that checkout on your account.',
  'billing.status.notActive': 'This payment isn’t confirmed yet.',
  'billing.status.unavailable': 'We can’t check your payment right now. Try again in a moment.',
});
