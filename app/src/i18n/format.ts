import { MINOR_PER_MAJOR, type Currency } from '@arrowbox/content-kit/pricing';
import { INTL_LOCALE } from './index';

// Dates and numbers in the page's locale (P3-7): components never pass a locale of their own or
// build these strings by hand. Pages are prerendered, so a date on one is formatted at build time
// in UTC; only a clock time the reader needs in their own zone uses their browser's conventions.

/** "3 Mar 2026" in en: a calendar date, in UTC so it's the same wherever the page was built. */
export const formatDate = (date: string | number | Date, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat(INTL_LOCALE, { timeZone: 'UTC', ...options }).format(new Date(date));

/** A number in the page's locale ("1,204" in en). */
export const formatNumber = (n: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(INTL_LOCALE, options).format(n);

/**
 * An amount of money from minor units (MINOR_PER_MAJOR in the price catalog), with the currency's
 * narrow symbol: 465000 INR is "₹4,650", 1300 USD is "$13", 70932 INR is "₹709.32". Whole amounts
 * drop the decimals, as prices do; any other amount shows the currency's. The symbol stays the
 * currency's in every locale (no "US$").
 */
export const formatMoney = (minor: number, currency: Currency) => {
  const perMajor = MINOR_PER_MAJOR[currency];
  const decimals = Math.round(Math.log10(perMajor));
  const whole = Number.isInteger(minor / perMajor);
  return formatNumber(minor / perMajor, {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: whole ? 0 : decimals,
    maximumFractionDigits: whole ? 0 : decimals,
  });
};

/** A whole-number share: 0.9 is "90%". */
export const formatPercent = (fraction: number) => formatNumber(fraction, { style: 'percent', maximumFractionDigits: 0 });

/** A position or count with at least two digits: "01", "12". */
export const formatTwoDigits = (n: number) => formatNumber(n, { minimumIntegerDigits: 2, useGrouping: false });

/**
 * A time of day in the reader's own zone and conventions (12- or 24-hour), for a moment they are
 * waiting for, e.g. when Ask's daily limit resets. Browser-only: the server doesn't know either.
 */
export const formatClockTime = (date: string | number | Date) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(date));

/** A country's name from its ISO 3166-1 alpha-2 code ("IN" is "India" in en), or the code itself. */
export const formatCountry = (code: string) => new Intl.DisplayNames([INTL_LOCALE], { type: 'region' }).of(code) ?? code;

/** A list in the locale's words: ["a", "b", "c"] is "a, b and c" in en. */
export const formatList = (items: string[]) => new Intl.ListFormat(INTL_LOCALE, { style: 'long', type: 'conjunction' }).format(items);

/** A currency's name from its ISO 4217 code ("INR" is "Indian Rupee" in en), or the code itself. */
export const formatCurrencyName = (code: string) => {
  try {
    return new Intl.DisplayNames([INTL_LOCALE], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
};
