import { translator, type Catalog, type Translator } from './core';
import { INTL_LOCALES, OG_LOCALES, type UiLocale } from './locales';
import { pseudoCatalog } from './pseudo';

// The interface's messages and formats in the build's locale (P3-7, docs/i18n.md). Every string
// the chrome shows comes from a namespace under ./messages, one module per island or page area so
// each island ships only its own; content comes from content/ and the CMS and is never here.
//
//   import t from '../../i18n/messages/reader';
//   t('contents')                          // "Contents"
//   t('account', { name: reader.username })
//
// Components format dates and numbers with ./format.ts, never with a hard-coded locale.

/** The build's interface locale (PUBLIC_UI_LOCALE, inlined at build time; `en` when unset). */
export const LOCALE: UiLocale = import.meta.env.PUBLIC_UI_LOCALE === 'en-XA' ? 'en-XA' : 'en';
/** <html lang>. */
export const LANG: string = LOCALE;
/** The tag Intl formats with (en-GB for `en`). */
export const INTL_LOCALE = INTL_LOCALES[LOCALE];
export const OG_LOCALE = OG_LOCALES[LOCALE];

/**
 * A namespace's translator. `catalog` is the English source, which also fixes the keys and the
 * values each message takes. In an en-XA build the messages are pseudo-localized here; a real
 * translation would be looked up here by the same keys.
 */
export function messages<const C extends Catalog>(catalog: C): Translator<C> {
  // A literal comparison after Vite's define: an `en` bundle drops the pseudo-locale's code.
  const active = import.meta.env.PUBLIC_UI_LOCALE === 'en-XA' ? pseudoCatalog(catalog) : catalog;
  return translator(catalog, active, INTL_LOCALE);
}

export type { Catalog, Translator } from './core';
