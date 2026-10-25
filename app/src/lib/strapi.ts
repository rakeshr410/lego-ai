import type { BlocksContent } from '@strapi/blocks-react-renderer';

// Types of the retired CMS page stack (the /frontend-designs tree now redirects), still used by
// headings.ts. The web no longer reads content from Strapi: pages are built from the content
// snapshot (content-snapshot.ts) and the server only calls Strapi for accounts and Ask
// (server/strapi-server.ts).

export type HeroBlock = {
  __component: 'blocks.hero';
  id: number;
  heading: string;
  subheading?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
};

export type RichTextBlock = {
  __component: 'blocks.rich-text';
  id: number;
  body: BlocksContent;
};

export type CalloutBlock = {
  __component: 'blocks.callout';
  id: number;
  tone: 'info' | 'note' | 'success' | 'warning' | 'error';
  body: BlocksContent;
};

export type TableOfContentsBlock = {
  __component: 'blocks.table-of-contents';
  id: number;
  title?: string | null;
  minLevel: number;
  maxLevel: number;
};

/** Inline content used inside table cells: Strapi rich-text inline nodes plus status labels. */
export type InlineNode =
  | {
      type: 'text';
      text: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strikethrough?: boolean;
      code?: boolean;
    }
  | { type: 'link'; url: string; children: InlineNode[] }
  | { type: 'status'; text: string; color: string };

export type TableCell = {
  content: InlineNode[];
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
};

export type TableBlock = {
  __component: 'blocks.table';
  id: number;
  caption?: string | null;
  data: { head: TableCell[][]; body: TableCell[][] };
};

export type Media = {
  url: string;
  alternativeText?: string | null;
  width?: number | null;
  height?: number | null;
};

export type ImageGalleryBlock = {
  __component: 'blocks.image-gallery';
  id: number;
  items: { id: number; caption?: string | null; image: Media | null }[];
};

export type ChecklistBlock = {
  __component: 'blocks.checklist';
  id: number;
  items: { id: number; checked: boolean; label?: string | null; text?: string | null }[];
};

export type TwoColumnsBlock = {
  __component: 'blocks.two-columns';
  id: number;
  left: BlocksContent;
  right: BlocksContent;
};

export type PageBlock =
  | HeroBlock
  | RichTextBlock
  | CalloutBlock
  | TableOfContentsBlock
  | TableBlock
  | ImageGalleryBlock
  | ChecklistBlock
  | TwoColumnsBlock;
