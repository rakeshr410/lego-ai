// The message catalog's runtime (P3-7, docs/i18n.md): typed keys, {placeholders}, plural forms
// and inline tags, with nothing locale-specific in the code. Pure: the locale comes in as an
// argument, so tests can build a translator for any of them (./index.ts binds the build's).
//
//   'Account: {name}'                      t('account', { name })
//   { one: '# topic', other: '# topics' }  t('topics', { count })   (# is the count, formatted)
//   'Sign in <link>here</link>.'           t.rich('signIn', { link: (text, key) => <a key={key}>{text}</a> })
//
// Numbers passed as values are formatted for the locale (Intl.NumberFormat); strings go in as they are.

/** A message's plural forms, picked with Intl.PluralRules; `other` is required. */
export type PluralForms = {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
};
export type Message = string | PluralForms;
/** One namespace's messages, by key. Flat: a dotted key ("zoom.label") is just a name. */
export type Catalog = { readonly [key: string]: Message };
export type Value = string | number;

type Texts<M> = M extends string ? M : M extends PluralForms ? Exclude<M[keyof M], undefined> : never;
type VarsIn<S> = S extends `${string}{${infer V}}${infer Rest}` ? V | VarsIn<Rest> : never;
type TagsIn<S> = S extends `${string}<${infer T}>${infer Rest}` ? (T extends `/${string}` ? never : T) | TagsIn<Rest> : never;

/** The values a message needs: one per {placeholder}, and `count` for plural forms. */
export type VarsOf<M> = { readonly [V in VarsIn<Texts<M>>]: Value } & (M extends PluralForms ? { readonly count: number } : unknown);
type Args<M> = [keyof VarsOf<M>] extends [never] ? [] : [vars: VarsOf<M>];
/** Renders one tag's text; `key` is its position, for React's list keys. */
export type TagRenderer<R> = (text: string, key: number) => R;
type TagsOf<M, R> = { readonly [T in TagsIn<Texts<M>>]: TagRenderer<R> };

export interface Translator<C extends Catalog> {
  /** The message for `key`, with its values filled in. */
  <K extends keyof C & string>(key: K, ...args: Args<C[K]>): string;
  /** The message split around its <tags>, each tag's text rendered by the function of that name. */
  rich<K extends keyof C & string, R>(key: K, args: VarsOf<C[K]> & TagsOf<C[K], R>): (string | R)[];
  /** The English source, as written (tests and tooling read it). */
  readonly source: C;
}

const VAR = /\{(\w+)\}/g;
const TAG = /<(\w+)>([\s\S]*?)<\/\1>/g;

/**
 * A translator over `messages` (the source, or a translation with the same keys) that formats
 * for `intlLocale`. A key missing from `messages` falls back to the source; the key itself shows
 * only if both lack it, which the types prevent.
 */
export function translator<C extends Catalog>(source: C, messages: Catalog = source, intlLocale = 'en-GB'): Translator<C> {
  let numbers: Intl.NumberFormat | undefined;
  let plurals: Intl.PluralRules | undefined;
  const num = (n: number) => (numbers ??= new Intl.NumberFormat(intlLocale)).format(n);

  const text = (key: string, vars?: Readonly<Record<string, unknown>>): string => {
    const m = messages[key] ?? source[key];
    if (m === undefined) return key;
    let s: string;
    if (typeof m === 'string') s = m;
    else {
      const count = Number(vars?.count ?? 0);
      s = (m[(plurals ??= new Intl.PluralRules(intlLocale)).select(count)] ?? m.other).replace(/#/g, num(count));
    }
    if (!vars) return s;
    return s.replace(VAR, (whole, name: string) => {
      const v = vars[name];
      return typeof v === 'number' ? num(v) : typeof v === 'string' ? v : whole;
    });
  };

  const rich = (key: string, args: Readonly<Record<string, unknown>>) => {
    const s = text(key, args);
    const out: unknown[] = [];
    let at = 0;
    for (const m of s.matchAll(TAG)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      const render = args[m[1]];
      out.push(typeof render === 'function' ? render(m[2], out.length) : m[2]);
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  };
  const t = (key: string, vars?: Readonly<Record<string, unknown>>) => text(key, vars);
  return Object.assign(t, { rich, source }) as unknown as Translator<C>;
}

/** The {placeholders} and <tags> a message uses, sorted (the catalog tests compare them across locales). */
export function slotsOf(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : Object.values(message).filter((v): v is string => typeof v === 'string');
  const slots = new Set<string>();
  for (const s of texts) {
    for (const m of s.matchAll(VAR)) slots.add(`{${m[1]}}`);
    for (const m of s.matchAll(TAG)) slots.add(`<${m[1]}>`);
  }
  return [...slots].sort();
}
