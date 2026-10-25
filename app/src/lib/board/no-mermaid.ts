// Stands in for @excalidraw/mermaid-to-excalidraw in the interview room (astro.config.mjs aliases
// the package here). Excalidraw loads the package when a candidate opens its "Mermaid to
// Excalidraw" dialog or pastes Mermaid text; the real one brings mermaid and its renderers, about
// 1.5 MB gzipped the site otherwise never ships to a browser (its diagrams are drawn at build
// time). The dialog shows this error instead.

export async function parseMermaidToExcalidraw(): Promise<never> {
  throw new Error('Mermaid import is not available in the interview room. Draw the boxes and arrows, or add them from the outline.');
}
