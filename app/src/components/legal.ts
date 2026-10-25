import tp from '../i18n/messages/pages';

// Legal and contact details shared by the footer and the /legal pages. The labels and the notice
// are interface text (i18n/messages/pages.ts); the /legal pages themselves are documents.
// PLACEHOLDER: set PUBLIC_CONTACT_EMAIL to a monitored inbox before launch.
export const CONTACT_EMAIL: string = import.meta.env.PUBLIC_CONTACT_EMAIL || 'legal@arrowbox.example';
// PLACEHOLDER: set PUBLIC_PRIVACY_EMAIL to the privacy and grievance inbox before launch.
export const PRIVACY_EMAIL: string = import.meta.env.PUBLIC_PRIVACY_EMAIL || 'privacy@arrowbox.example';

export const LEGAL_LINKS = [
  { href: '/legal/terms', label: tp('legal.terms') },
  { href: '/legal/privacy', label: tp('legal.privacy') },
  { href: '/legal/refunds', label: tp('legal.refunds') },
  { href: '/legal/disclaimer', label: tp('legal.disclaimer') },
] as const;

/** Shown in the footer and on the disclaimer page. */
export const BRAND_NOTICE = tp('legal.brandNotice');
