// The one Markdown renderer of the page. parse* functions are pure (text -> plain node tree), so node tests them;
// renderCellContent is the only DOM writer. Each part lives in its own file under markdown/; this file is the one
// entry point the pages import.
export type { InlineNode, LinkDefinition } from './markdown/inline.ts';
export { normalizeLabel, parseInline, plainTextOf } from './markdown/inline.ts';
export type { Block } from './markdown/blocks.ts';
export { definitionOf, parseCellBlocks, quoteContentOf } from './markdown/blocks.ts';
export { parseDocumentBlocks } from './markdown/document.ts';
export type { DocumentIndex } from './markdown/document-index.ts';
export { documentIndexOf } from './markdown/document-index.ts';
export { linkTargetOf } from './markdown/links.ts';
export { renderCellContent, renderDocument } from './markdown/render.ts';
