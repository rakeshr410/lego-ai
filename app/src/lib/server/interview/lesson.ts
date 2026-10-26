import { textContext } from '@arrowbox/content-kit';
import { blockText, type Block } from '../ask-grounding';
import { getSnapshot, topicAt, type SnapshotTopic } from '../../content-snapshot';
import { sectionBlocksOf } from '../coaching/hash';
import type { Plan } from './plans';

// The coach's lesson material (docs/coach-mode.md): the article text of each section the
// plan covers, rendered from the topic's content blocks the way Ask grounds its answers
// (ask-grounding.ts), so the coach teaches what the site says and nothing else. A section's text is
// capped; the coach reads it from the stage's lesson notes (prompt.ts).

/** Characters of one section's material the coach is given. */
export const MATERIAL_MAX = 7000;

const topicOf = (system: string, slug: string): SnapshotTopic | undefined => topicAt(getSnapshot(), system, slug);
/** The system a plan's section belongs to: a playlist's lesson draws on several (coaching/lessons.ts). */
const systemOf = (plan: Plan, section: string) => plan.lesson?.sections.find((s) => s.key === section)?.system ?? plan.system.slug;

/** The blocks between a section heading and the next, by the section's key (`<topic>/<sectionKey>`). */
export function sectionBlocks(topic: Pick<SnapshotTopic, 'content'>, sectionKey: string): Block[] | null {
  return sectionBlocksOf((topic.content ?? []) as (Block & { key?: string })[], sectionKey);
}

/** One section's article text for the coach, or null when the topic or section is not in the snapshot. */
export function sectionMaterial(plan: Plan, section: string): string | null {
  const [slug, ...rest] = section.split('/');
  const sectionKey = rest.join('/');
  const topic = topicOf(systemOf(plan, section), slug);
  if (!topic) return null;
  const blocks = sectionBlocks(topic, sectionKey);
  if (!blocks) return null;
  const ctx = textContext(topic.content as Block[], topic.components, topic.tools);
  const text = blocks
    .map((b) => blockText(b, ctx))
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (!text) return null;
  return text.length > MATERIAL_MAX ? `${text.slice(0, MATERIAL_MAX)}…` : text;
}

type DiagramBlock = {
  title?: string;
  groups?: { key: string; label?: string; sublabel?: string; parent?: string | null }[];
  nodes?: { key: string; title?: string; parent?: string | null; details?: string[] }[];
  edges?: { from: string; to: string; label?: string }[];
};

/** Characters of one diagram's description the coach is given. */
export const DIAGRAM_MAX = 1800;

/**
 * The article's own pictures of a section: each component diagram's groups, boxes and arrows, in the
 * article's layout, as lines the coach can draw from (docs/coach-mode.md, "Drawing"). Empty
 * when the section has none.
 */
export function sectionDiagrams(plan: Plan, section: string): string[] {
  const [slug, ...rest] = section.split('/');
  const topic = topicOf(systemOf(plan, section), slug);
  if (!topic) return [];
  const blocks = sectionBlocks(topic, rest.join('/'));
  if (!blocks) return [];
  const components = (topic.components ?? []) as { key: string; name?: string }[];
  return blocks
    .filter((b) => b.__component === 'sd.component-diagram')
    .map((b) => {
      const d = b as unknown as DiagramBlock;
      const names = new Map<string, string>();
      for (const g of d.groups ?? []) names.set(g.key, g.label || components.find((c) => c.key === g.key)?.name || g.key);
      for (const n of d.nodes ?? []) names.set(n.key, n.title || components.find((c) => c.key === n.key)?.name || n.key);
      const name = (k: string) => names.get(k.trim()) ?? k.trim();
      const inside = (parent: string | null | undefined) => (parent && names.has(parent) ? ` (in ${names.get(parent)})` : '');
      const lines = [
        ...(d.groups ?? []).map((g) => `group ${name(g.key)}${inside(g.parent)}${g.sublabel ? `: ${g.sublabel}` : ''}`),
        ...(d.nodes ?? []).map((n) => {
          // The article gives a box's details as a list, or as one line of text.
          const details: unknown = n.details;
          const shown = (Array.isArray(details) ? details : typeof details === 'string' && details.trim() ? [details] : []).slice(0, 2).map(String);
          return `box ${name(n.key)}${inside(n.parent)}${shown.length ? `: ${shown.join('; ')}` : ''}`;
        }),
        ...(d.edges ?? []).map((e) => `arrow ${name(e.from)} -> ${name(e.to)}${e.label ? ` (${e.label})` : ''}`),
      ];
      const text = lines.join('\n');
      return `${d.title ? `${d.title}\n` : ''}${text.length > DIAGRAM_MAX ? `${text.slice(0, DIAGRAM_MAX)}…` : text}`;
    })
    .filter((s) => s.trim().length > 0);
}
