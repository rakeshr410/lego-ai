import { describe, expect, it } from 'vitest';
import { Pointer, words } from './pointer';

const board = [
  { id: 'store', text: 'Feed Store' },
  { id: 'list', text: 'FeedList, virtual list' },
  { id: 'text', text: 'story text' },
  { id: 'fr1', text: '1. newest first, author, text, images, counts' },
  { id: 'nfr3', text: '3. 25 cards, tasks under 50 ms, INP 200 ms' },
  { id: 'heading', text: 'Functional' },
];

const say = (p: Pointer, sentence: string) => sentence.split(' ').map((w) => p.hear(w, board)).filter(Boolean);

describe('the pointer', () => {
  it('reads a label as the voice says it: camel case apart, filler words and a line number left out', () => {
    expect(words('FeedList, virtual list')).toEqual(['feed', 'list', 'virtual', 'list']);
    expect(words('the Feed Store')).toEqual(['feed', 'store']);
  });

  it('names a spot when the words heard run through two of its words, or a whole one-word label', () => {
    const p = new Pointer();
    expect(say(p, 'Each card reads its story from the feed store by id.')).toEqual(['store']);
    expect(say(p, 'The feed list mounts only what is in range.')).toEqual(['list']);
    expect(say(p, 'Under functional we write what it does.')).toEqual(['heading']);
    expect(say(p, 'Stories come newest first, with their author.')).toEqual(['fr1']);
    expect(say(p, 'At most 25 cards are mounted.')).toEqual(['nfr3']);
  });

  it('does not point at a spot for one shared word, or again at the one it is on', () => {
    const p = new Pointer();
    expect(say(p, 'A story is short.')).toEqual([]);
    expect(say(p, 'The story text sits under the author row, story text again.')).toEqual(['text']);
    p.reset();
    expect(say(p, 'story text')).toEqual(['text']);
  });
});
