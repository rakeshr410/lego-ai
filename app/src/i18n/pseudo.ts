import type { Catalog, Message } from './core';

// The en-XA pseudo-locale (P3-7, docs/i18n.md): every catalog message with its letters accented,
// about 40% longer and in brackets, "Contents" becoming "[Çöñţéñţš one]". Text that is still plain
// English in an en-XA build skipped the catalog (content aside, which stays English on purpose);
// a layout that clips or overflows would do the same with a longer language. Placeholders, tags
// and plural counts are kept as they are.

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};
const PADDING = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** How much longer than English a pseudo message is: roughly German or Finnish. */
export const EXPANSION = 0.4;
/** Placeholders and tags, which stay as they are; everything else is text. */
const PART = /(\{\w+\}|<\/?\w+>)|([^{<]+|[{<])/g;

/** One string in the pseudo-locale. Strings without letters (symbols, numbers) are unchanged. */
export function pseudo(s: string): string {
  let letters = 0;
  let length = 0;
  const body = s.replace(PART, (_, kept: string | undefined, text: string | undefined) => {
    if (kept) return kept;
    let out = '';
    for (const c of text ?? '') {
      const a = ACCENTS[c];
      if (a) letters++;
      length++;
      out += a ?? c;
    }
    return out;
  });
  if (letters === 0) return s;
  const want = Math.ceil(length * EXPANSION);
  const pad: string[] = [];
  for (let n = 0, i = 0; n < want; i++) {
    const word = PADDING[i % PADDING.length];
    pad.push(word);
    n += word.length + 1;
  }
  return `[${body} ${pad.join(' ')}]`;
}

const pseudoMessage = (m: Message): Message =>
  typeof m === 'string' ? pseudo(m) : (Object.fromEntries(Object.entries(m).map(([k, v]) => [k, pseudo(v)])) as Message);

/** A namespace's messages in the pseudo-locale. */
export const pseudoCatalog = (catalog: Catalog): Catalog =>
  Object.fromEntries(Object.entries(catalog).map(([k, m]) => [k, pseudoMessage(m)]));
