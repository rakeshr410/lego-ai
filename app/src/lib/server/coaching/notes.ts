import { escapeTagged } from '../tutor';
import { layoutLine } from './layout';
import type { LessonInfo } from './lessons';

// What the coach reads of a pack (docs/coaching.md): the section's context (what the learner
// already has, what this section hands on, the words it uses), each beat's teaching notes, the
// answer its check wants, the misconceptions to correct, and the board plan the beat draws with
// <place>. It travels in the part's lesson notes (prompt.ts), beside the article's text, so the
// coach teaches the reviewed material and still has the article for the learner's doubts.

/** A section's pack as notes, its beats numbered as the part's items are (`numberOf`); empty when the section falls back to the article. */
export function packNotes(info: LessonInfo, key: string, numberOf: (itemId: string) => number): string {
  const s = info.sections.find((x) => x.key === key);
  const p = s?.pack;
  if (!s || !p) return '';
  const lines = [
    `<pack section="${key.split('/').pop()}" title="${escapeTagged(p.title)}">`,
    ...(p.context.assumes.length ? [`The learner already has (refer to it, don't reteach): ${p.context.assumes.map(escapeTagged).join('; ')}`] : []),
    `This section hands on: ${p.context.carries.map(escapeTagged).join('; ')}`,
    ...(p.context.terms.length ? [`Terms, one meaning each: ${p.context.terms.map((t) => `${escapeTagged(t.term)} = ${escapeTagged(t.means)}`).join('; ')}`] : []),
  ];
  p.beats.forEach((b, n) => {
    const item = numberOf(`${key}/${n + 1}`);
    lines.push(`Item ${item}: ${escapeTagged(b.point)}`);
    lines.push(`  Teach: ${b.teach.map(escapeTagged).join(' ')}`);
    if (b.draw?.length) {
      lines.push(`  Draw, as you say it: <place ids="${b.draw.join(',')}"/> (split it across your sentences, each id at the point where its name comes in what you say, in place of the name: a spoken lesson reads each label aloud as the pen writes it, so the name is not said twice), which puts on the board:`);
      for (const id of b.draw) {
        const x = info.layout.get(id);
        if (x) lines.push(`    ${escapeTagged(layoutLine(x, info.layout))}`);
      }
    }
    if (b.answer) lines.push(`  A right answer to its check: ${escapeTagged(b.answer)}`);
    if (b.misconceptions?.length) lines.push(`  Correct these if you hear them: ${b.misconceptions.map(escapeTagged).join(' | ')}`);
  });
  lines.push('</pack>');
  return lines.join('\n');
}

/** The board plan's ids for a lesson item (`<section key>/<n>`, its pack's nth beat), in drawing order; none without a pack. */
export function plannedIds(info: LessonInfo, itemId: string): string[] {
  const cut = itemId.lastIndexOf('/');
  const key = itemId.slice(0, cut);
  const n = Number(itemId.slice(cut + 1));
  const pack = info.sections.find((x) => x.key === key)?.pack;
  return (Number.isInteger(n) && pack?.beats[n - 1]?.draw) || [];
}

/** What the board already has when the lesson opens (kept from earlier lessons), for the first part's notes. */
export function startNotes(info: LessonInfo): string {
  if (!info.start.length) return '';
  const lines = info.start.map((id) => info.layout.get(id)).flatMap((x) => (x ? [`  ${escapeTagged(layoutLine(x, info.layout))}`] : []));
  return `The board opens with these, kept from earlier lessons and drawn for you before your first words (refer to them, don't place them again):\n${lines.join('\n')}`;
}

/** What earlier lessons of the playlist left with this learner (coaching/progress.ts), for the system block. */
export function recallNotes(recall: readonly string[] | undefined): string {
  if (!recall?.length) return '';
  return `\n\n<learner>\nFrom this learner's earlier lessons in the playlist (use it: build on what held, revisit what was shaky in a sentence when it comes up, don't repeat what was understood):\n${recall.map((r) => `- ${escapeTagged(r)}`).join('\n')}\n</learner>`;
}

/** The drawing rule a lesson adds: its board is planned, and placed by id. */
export const LESSON_DRAWING =
  `This lesson's board is planned: each item's notes give the ids to draw with <place ids="..."/> (the draw tool's ` +
  `"place" operation), which puts regions, boxes, notes and arrows exactly where the plan has them, so the board ends ` +
  `up as the lesson's picture. Draw with <place> on every move whose coach element says draw="yes" and names ids, ` +
  `in the order given, each part at the point in your sentence where it comes in, never as a separate pass after ` +
  `you have explained it; a move that teaches an item without its drawing leaves the learner with words and no ` +
  `picture. Use the other operations only to point at something (highlight) or for a drawing the plan lacks; ` +
  `your own boxes and notes go in the side notes, to the right of the lesson, so they never sit among its parts. A ` +
  `region is a labelled panel; the boxes inside it belong to it. A numbered list (requirements, targets) numbers its ` +
  `lines as they are written: place its lines without numbers of your own. While the learner gives a list (move ` +
  `capture) you write their points as notes on it instead, <note text="their words" covers="the plan line's id"/>.`;
