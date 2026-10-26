// What the voice is talking about on the board (docs/coach-mode.md, phase 5): the words the coach says, as
// they are heard, matched against the words written on the board, so the pen can hover over what is being
// explained the way a hand does, and not only move when it draws. A label is named when the last words
// heard run through enough of it: two of its words in a row, or the whole of a one-word label.

/** A piece of writing on the board: an element's id and its words. */
export type Spot = { id: string; text: string };

// Words that say nothing about which element is meant.
const FILLER = new Set(
  'a an and are as at be by each for from in is it its no not of on or per so that the then this to with we our you your'.split(' '),
);

/** The words of a text: camel case apart ("FeedList" is "feed list"), lower case, letters and digits only. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
}

/** How far the end of `heard` runs through `label`: the longest run of the label's words the heard words end with. */
function run(heard: readonly string[], label: readonly string[]): number {
  let best = 0;
  for (let start = 0; start < label.length; start++) {
    for (let k = Math.min(label.length - start, heard.length); k > best; k--) {
      let same = true;
      for (let i = 0; i < k && same; i++) same = label[start + i] === heard[heard.length - k + i];
      if (same) best = k;
    }
  }
  return best;
}

const KEEP = 12;
const ONE_WORD_MIN = 5;

export class Pointer {
  private heard: string[] = [];
  private at: string | null = null;

  /** A new turn of speech: what was said before names nothing now. */
  reset(): void {
    this.heard = [];
    this.at = null;
  }

  /**
   * Words just heard. Returns the spot they name, when it is not the one already pointed at: the longest run
   * of a label wins, then the one run through furthest, then the one written last.
   */
  hear(text: string, spots: readonly Spot[]): string | null {
    const fresh = words(text);
    if (!fresh.length) return null;
    this.heard = [...this.heard, ...fresh].slice(-KEEP);
    let best: { id: string; k: number; share: number; n: number } | null = null;
    spots.forEach((s, n) => {
      const label = words(s.text).filter((w) => !/^\d+$/.test(w) || s.text.trim().indexOf(w) > 0); // "1." of a numbered line is not a word of it
      if (!label.length) return;
      const k = run(this.heard, label);
      const named = k >= 2 || (k === 1 && label.length === 1 && label[0].length >= ONE_WORD_MIN);
      if (!named) return;
      const share = k / label.length;
      if (!best || k > best.k || (k === best.k && (share > best.share || (share === best.share && n > best.n)))) best = { id: s.id, k, share, n };
    });
    const found = best as { id: string } | null;
    if (!found || found.id === this.at) return null;
    this.at = found.id;
    return found.id;
  }
}
