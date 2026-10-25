// The interface locales a build can be made in (P3-7, docs/i18n.md). One locale per build: the
// pages are prerendered, so PUBLIC_UI_LOCALE picks it at build time and Vite inlines it
// (astro.config.mjs, workbench/vite.config.ts). `en` is the site; `en-XA` is a pseudo-locale for
// testing, its messages accented and lengthened (./pseudo.ts) to show strings that skip the
// catalog and layouts that break with longer text. Content (topics, the CMS's picker labels)
// stays English in every locale.

export const UI_LOCALES = ['en', 'en-XA'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

export const DEFAULT_LOCALE: UiLocale = 'en';

/**
 * The tag Intl formats dates and numbers with, per locale. The site writes British English
 * ("3 Mar 2026", "Practise"), so `en` formats as en-GB while <html lang> stays `en`.
 */
export const INTL_LOCALES: Record<UiLocale, string> = { en: 'en-GB', 'en-XA': 'en-XA' };

/** Open Graph's og:locale (language_TERRITORY). */
export const OG_LOCALES: Record<UiLocale, string> = { en: 'en_GB', 'en-XA': 'en_XA' };

export const isUiLocale = (value: unknown): value is UiLocale => (UI_LOCALES as readonly unknown[]).includes(value);

/**
 * The build's locale as a Vite `define`, so `import.meta.env.PUBLIC_UI_LOCALE` is a literal in
 * the bundle and the pseudo-locale's code drops out of an `en` build. Unset means `en`; anything
 * else that isn't a locale above fails the build.
 */
export function uiLocaleDefine(value: string | undefined): Record<string, string> {
  const locale = value?.trim() || DEFAULT_LOCALE;
  if (!isUiLocale(locale)) throw new Error(`PUBLIC_UI_LOCALE=${value} is not one of ${UI_LOCALES.join(', ')}`);
  return { 'import.meta.env.PUBLIC_UI_LOCALE': JSON.stringify(locale) };
}
