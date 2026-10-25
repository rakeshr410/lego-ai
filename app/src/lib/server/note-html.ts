import { parse, type DefaultTreeAdapterTypes as T } from 'parse5';
import { sanitizeTree, type HtmlTree } from '../note-sanitize';

// Server side of note HTML cleaning: the same allowlist and walker as the browser
// (lib/note-sanitize.ts) over a parse5 tree, applied before a note is stored, so what Strapi holds
// is safe to render anywhere (an export, an admin view, a shared note), not only in Ask mode.

const tree: HtmlTree<T.Node> = {
  kind: (n) => (n.nodeName === '#text' ? 'text' : 'tagName' in n ? 'element' : 'other'),
  tag: (n) => (n as T.Element).tagName,
  namespace: (n) => (n as T.Element).namespaceURI,
  // A <template>'s content isn't among its children, as in the DOM (templates are dropped anyway).
  children: (n) => ('childNodes' in n ? n.childNodes : []),
  text: (n) => (n as T.TextNode).value,
  attr: (n, name) => (n as T.Element).attrs.find((a) => a.name === name && !a.namespace)?.value ?? null,
};

/**
 * Returns `html` reduced to allowed formatting: exactly what the browser's sanitizeNoteHtml
 * returns for it. Parsed as the browser's DOMParser does (a document, scripting off).
 */
export function sanitizeNoteHtml(html: string): string {
  const doc = parse(`<body>${html}</body>`, { scriptingEnabled: false });
  const htmlEl = doc.childNodes.find((n): n is T.Element => n.nodeName === 'html');
  const body = htmlEl?.childNodes.find((n): n is T.Element => n.nodeName === 'body');
  return body ? sanitizeTree(body.childNodes, tree) : '';
}
