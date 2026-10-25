// The one allowlist for Ask note HTML, and the walker that applies it. Readers edit notes as rich
// text; the HTML is stored and put back into the page, so it's reduced to formatting only: an
// allowlist of tags, no attributes but `style`, and only allowlisted style properties with plain
// values. Anything else is unwrapped (its text kept) or, for scripts, frames and the like,
// dropped with everything inside.
//
// Both sides run exactly this code over a parsed tree: the browser before it puts a note into the
// page (lib/note-html.ts, DOMParser) and the server before it stores one (lib/server/note-html.ts,
// parse5, the same HTML parsing algorithm). The output is serialized here, not by either DOM, so
// both produce the same string, and it can hold nothing but allowlisted tags and escaped text.

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export const KEEP_TAGS: ReadonlySet<string> = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h4', 'ul', 'ol', 'li', 'code', 'span', 'mark']);

/** Dropped with their contents (the rest of what isn't kept is unwrapped). */
export const DROP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'svg', 'math', 'link', 'meta', 'base',
  'img', 'image', 'picture', 'video', 'audio', 'source', 'track', 'canvas', 'form', 'input', 'textarea', 'button', 'select', 'option',
  'noscript', 'noembed', 'noframes', 'title', 'head', 'portal', 'fencedframe',
]);

export const STYLE_PROPS: ReadonlySet<string> = new Set([
  'color', 'background-color', 'background', 'font', 'font-weight', 'font-style', 'font-family', 'font-size', 'text-decoration', 'padding', 'border-radius',
]);

// Words, numbers, colours and functions like oklch(); no ':' ';' '\' '*' '!' '<' '>' '&' '@'.
const SAFE_VALUE = /^[\w\s#.,%'"()/-]*$/;
const UNSAFE_WORD = /url|expression|image|var\(|attr\(|env\(/i;
const count = (s: string, ch: string) => s.split(ch).length - 1;
// An unclosed quote or bracket would run on into whatever the browser parses next.
const balanced = (v: string) => count(v, '"') % 2 === 0 && count(v, "'") % 2 === 0 && count(v, '(') === count(v, ')');

const VOID_TAGS: ReadonlySet<string> = new Set(['br']);

/** The allowed declarations of a style attribute, as `prop:value;prop:value`. */
export function cleanStyle(style: string | null): string {
  if (!style) return '';
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim().replace(/\s+/g, ' ');
    if (value && STYLE_PROPS.has(prop) && SAFE_VALUE.test(value) && !UNSAFE_WORD.test(value) && balanced(value)) out.push(`${prop}:${value}`);
  }
  return out.join(';');
}

/** A read-only view of a parsed HTML tree, so the browser DOM and parse5 share the walker. */
export type HtmlTree<N> = {
  kind(node: N): 'text' | 'element' | 'other';
  /** Lower-case local name of an element. */
  tag(node: N): string;
  namespace(node: N): string | null;
  children(node: N): readonly N[];
  text(node: N): string;
  attr(node: N, name: string): string | null;
};

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
const escapeAttr = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');

function walk<N>(node: N, tree: HtmlTree<N>, out: string[]) {
  const kind = tree.kind(node);
  if (kind === 'text') {
    out.push(escapeText(tree.text(node)));
    return;
  }
  if (kind !== 'element') return; // comments, doctypes, processing instructions
  const tag = tree.tag(node);
  // SVG and MathML content is dropped whole; so is anything that runs, loads or embeds.
  if (tree.namespace(node) !== HTML_NS || DROP_TAGS.has(tag)) return;
  const keep = KEEP_TAGS.has(tag);
  if (keep) {
    const style = cleanStyle(tree.attr(node, 'style'));
    out.push(style ? `<${tag} style="${escapeAttr(style)}">` : `<${tag}>`);
    if (VOID_TAGS.has(tag)) return;
  }
  for (const child of tree.children(node)) walk(child, tree, out);
  if (keep) out.push(`</${tag}>`);
}

/** The allowed formatting of a parsed note (the children of its <body>), as HTML. */
export function sanitizeTree<N>(nodes: readonly N[], tree: HtmlTree<N>): string {
  const out: string[] = [];
  for (const n of nodes) walk(n, tree, out);
  return out.join('');
}
