// Search and share metadata (P2-10, UX-1): canonical URLs, Open Graph and Twitter tags, JSON-LD,
// the sitemap and robots.txt. Pages are prerendered, so every URL here is absolute against the
// build's `site` (PUBLIC_ORIGIN, astro.config.mjs).
import { LANG } from '../i18n';
import tp from '../i18n/messages/pages';

export const SITE_NAME = 'Arrowbox';

/** The share image used when a page has none of its own (1200×630, public/og/default.png). */
export const DEFAULT_OG_IMAGE = { path: '/og/default.png', width: 1200, height: 630, alt: tp('meta.ogImageAlt') };

/** A path as the site serves it: no trailing slash (except the home page), no query or hash. */
export function canonicalPath(path: string): string {
  const p = path.split(/[?#]/)[0].replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  return p === '/' || p === '' ? '/' : p.replace(/\/+$/, '');
}

/** An absolute URL for a site path. */
export const absoluteUrl = (path: string, site: URL | string) => new URL(canonicalPath(path), site).href;

export type Crumb = { name: string; path: string };

/** schema.org BreadcrumbList for a trail of pages; the last crumb is the page itself. */
export function breadcrumbList(crumbs: Crumb[], site: URL | string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path, site),
    })),
  };
}

/** schema.org FAQPage: the questions on the page, each with its whole answer as plain text. */
export function faqPage(items: { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })),
  };
}

const publisher = (site: URL | string) => ({
  '@type': 'Organization',
  name: SITE_NAME,
  url: absoluteUrl('/', site),
  logo: { '@type': 'ImageObject', url: absoluteUrl('/icon-512.png', site), width: 512, height: 512 },
});

export type ArticleInput = {
  title: string;
  description?: string | null;
  path: string;
  /** ISO date or date-time of the last content change. */
  dateModified?: string | null;
  /** The system the design is modelled on, e.g. "Instagram". */
  about?: string | null;
  /** Section names, in order. */
  sections?: string[];
  readMinutes?: number | null;
  image?: string;
};

/** schema.org TechArticle for a topic page. */
export function techArticle(a: ArticleInput, site: URL | string) {
  const url = absoluteUrl(a.path, site);
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: a.title,
    ...(a.description ? { description: a.description } : {}),
    url,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(a.dateModified ? { dateModified: a.dateModified } : {}),
    inLanguage: LANG,
    isAccessibleForFree: true,
    learningResourceType: 'Illustrative system design',
    proficiencyLevel: 'Intermediate',
    ...(a.about ? { about: { '@type': 'Thing', name: tp('system.name', { name: a.about }) } } : {}),
    ...(a.sections?.length ? { articleSection: a.sections } : {}),
    ...(a.readMinutes ? { timeRequired: `PT${a.readMinutes}M` } : {}),
    image: absoluteUrl(a.image ?? DEFAULT_OG_IMAGE.path, site),
    author: publisher(site),
    publisher: publisher(site),
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: absoluteUrl('/', site) },
  };
}

/** schema.org CollectionPage listing a system hub's topics. */
export function collectionPage(
  page: { name: string; description?: string | null; path: string; items: { name: string; path: string }[] },
  site: URL | string,
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: page.name,
    ...(page.description ? { description: page.description } : {}),
    url: absoluteUrl(page.path, site),
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: absoluteUrl('/', site) },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: page.items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: absoluteUrl(it.path, site) })),
    },
  };
}

export type OfferInput = { name: string; price: number; currency: string; interval: 'monthly' | 'quarterly' | 'annual' };

/**
 * schema.org Product with an Offer per paid price, for the pricing page (docs/phase-4-design.md
 * §2.2: USD, on the page every region but India sees). `price` is in major units (20 for $20). No
 * `availability`: the page is prerendered, while whether checkout takes USD is a runtime setting
 * (BILLING_ENABLED, BILLING_INTL_ENABLED), so the build can't honestly say InStock.
 */
export function pricingProduct(page: { name: string; description?: string | null; path: string; offers: OfferInput[] }, site: URL | string) {
  const url = absoluteUrl(page.path, site);
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: page.name,
    ...(page.description ? { description: page.description } : {}),
    url,
    brand: { '@type': 'Brand', name: SITE_NAME },
    offers: page.offers.map((o) => ({
      '@type': 'Offer',
      name: o.name,
      url,
      price: o.price.toFixed(2),
      priceCurrency: o.currency,
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: o.price.toFixed(2),
        priceCurrency: o.currency,
        billingDuration: 1,
        // UN/CEFACT units: ANN a year, QAN a quarter, MON a month.
        unitCode: o.interval === 'annual' ? 'ANN' : o.interval === 'quarterly' ? 'QAN' : 'MON',
      },
    })),
  };
}

/**
 * JSON for a <script type="application/ld+json"> body. `<`, `>` and `&` are escaped so content
 * can never close the script element, and U+2028/2029 so it is also valid JavaScript.
 */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export type SitemapEntry = { path: string; lastmod?: string | null };

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A W3C date (YYYY-MM-DD) from an ISO date or date-time, or null when it doesn't parse. */
export function w3cDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** sitemaps.org XML for the given pages, sorted and de-duplicated by URL. */
export function sitemapXml(entries: SitemapEntry[], site: URL | string): string {
  const byUrl = new Map<string, string | null>();
  for (const e of entries) {
    const url = absoluteUrl(e.path, site);
    const lastmod = w3cDate(e.lastmod);
    const prev = byUrl.get(url);
    byUrl.set(url, prev && (!lastmod || prev > lastmod) ? prev : lastmod);
  }
  const urls = [...byUrl]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([loc, lastmod]) => `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/** The latest of some dates (ISO strings), or null. */
export function latest(dates: (string | null | undefined)[]): string | null {
  return dates.filter((d): d is string => !!w3cDate(d)).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

/**
 * robots.txt: crawl the pages, not the API or the account screens, and find the sitemap.
 * `allow: false` (a site built without PUBLIC_ORIGIN, e.g. a preview) turns crawling off.
 */
export function robotsTxt(site: URL | string, { allow = true }: { allow?: boolean } = {}): string {
  const lines = ['User-agent: *'];
  if (allow) lines.push('Disallow: /api/', 'Disallow: /signin', 'Disallow: /reset-password');
  else lines.push('Disallow: /');
  lines.push('', `Sitemap: ${absoluteUrl('/sitemap.xml', site)}`, '');
  return lines.join('\n');
}
