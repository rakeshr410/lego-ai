import type { BlocksContent } from '@strapi/blocks-react-renderer';
import type { PageBlock } from './strapi';

export type HeadingEntry = { id: string; level: number; text: string };

type Node = { type: string; text?: string; children?: Node[]; level?: number };

export function plainText(nodes: Node[] = []): string {
  return nodes.map((n) => n.text ?? plainText(n.children)).join('');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function headingsIn(content: BlocksContent | null | undefined): HeadingEntry[] {
  return ((content ?? []) as Node[])
    .filter((n) => n.type === 'heading')
    .map((n) => {
      const text = plainText(n.children);
      return { id: slugify(text), level: n.level ?? 2, text };
    });
}

/** All rich-text headings on a page in document order; ids match what RichText renders. */
export function collectHeadings(blocks: PageBlock[]): HeadingEntry[] {
  return blocks.flatMap((b) => {
    switch (b.__component) {
      case 'blocks.rich-text':
        return headingsIn(b.body);
      case 'blocks.callout':
        return headingsIn(b.body);
      case 'blocks.two-columns':
        return [...headingsIn(b.left), ...headingsIn(b.right)];
      default:
        return [];
    }
  });
}
