import { CONSENT_EVENT, analyticsAllowed, needsChoice, privacySignal, readConsent, saveConsent, type Consent } from './consent';

// The privacy choices banner (components/ConsentBanner.astro, P3-2): shown on every page until the
// reader answers, and again from the footer's "Privacy choices". It is not modal and takes no
// focus when it appears by itself; opened from the footer, focus moves into it and goes back to
// the footer button when it closes. Analytics code is only downloaded once analytics is allowed.
//
// While it shows, it reserves its own height at the foot of the page (--consent-clearance, read by
// site.css and picker.css as scroll padding and end space), so a control reached with Tab is
// scrolled clear of it rather than hidden behind it (WCAG 2.2 SC 2.4.11, Focus Not Obscured).
// Escape anywhere puts it away for this page view; unanswered, it is back on the next page.

const STATE = {
  on: 'Analytics is on. Thank you: it helps decide what to write and fix next.',
  off: 'Analytics is off. Only what the site needs to work is stored.',
  signal: 'Your browser sends Global Privacy Control or Do Not Track, so analytics stays off.',
};

let counted = false;

/** This page view, once analytics is allowed (now, or later from the banner on this page). */
function countView() {
  if (counted) return;
  counted = true;
  void import('./analytics').then((m) => m.trackPageView());
}

export function startConsent() {
  const banner = document.querySelector<HTMLElement>('[data-consent]');
  if (!banner) return;
  const state = banner.querySelector<HTMLElement>('[data-consent-state]');
  const choices = [...banner.querySelectorAll<HTMLButtonElement>('[data-consent-choice]')];
  let opener: HTMLElement | null = null;

  const root = document.documentElement;
  // The banner's height plus the gap below it, and the same gap again above it.
  const reserve = () => {
    const gap = parseFloat(getComputedStyle(banner).bottom) || 0;
    root.style.setProperty('--consent-clearance', `${Math.ceil(banner.offsetHeight + 2 * gap)}px`);
  };
  const sizer = new ResizeObserver(reserve);

  const show = (focus: boolean) => {
    const c = readConsent();
    const signal = privacySignal();
    if (state) state.textContent = signal ? STATE.signal : c ? (c.analytics ? STATE.on : STATE.off) : '';
    for (const b of choices) {
      b.hidden = signal;
      b.setAttribute('aria-pressed', String(!!c && c.analytics === (b.dataset.consentChoice === 'analytics')));
    }
    banner.querySelector<HTMLElement>('[data-consent-close]')!.hidden = !signal && !c;
    banner.hidden = false;
    reserve();
    sizer.observe(banner);
    if (focus) (choices.find((b) => !b.hidden) ?? banner).focus({ preventScroll: true });
  };
  const hide = () => {
    const hadFocus = banner.contains(document.activeElement);
    banner.hidden = true;
    sizer.disconnect();
    root.style.removeProperty('--consent-clearance');
    // Focus goes back where the banner was opened from or, if it was in the banner, to the footer's
    // "Privacy choices" (where it can be opened again), never to the top of the page.
    const back = opener?.isConnected ? opener : hadFocus ? document.querySelector<HTMLElement>('[data-consent-open]') : null;
    back?.focus({ preventScroll: true });
    opener = null;
  };

  banner.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-consent-choice], [data-consent-close]');
    if (!t) return;
    if (t.dataset.consentChoice) saveConsent(t.dataset.consentChoice === 'analytics');
    hide();
  });
  // Escape, from the banner or anywhere else on the page, puts it away for this page view. Not when
  // something else took the key (a dialog, a menu, a field clearing itself): that Escape is theirs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || banner.hidden) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && !banner.contains(t) && t.closest('dialog,[role=dialog],[role=menu],[role=listbox],[role=combobox],input,textarea,select,[contenteditable]')) return;
    hide();
  });
  document.addEventListener('click', (e) => {
    const open = (e.target as HTMLElement).closest<HTMLElement>('[data-consent-open]');
    if (!open) return;
    e.preventDefault();
    opener = open;
    show(true);
  });

  if (analyticsAllowed()) countView();
  else addEventListener(CONSENT_EVENT, (e) => (e as CustomEvent<Consent>).detail.analytics && countView());
  if (needsChoice()) show(false);
}
