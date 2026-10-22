// The one Markdown renderer of the page. parse* functions are pure (text -> plain node tree), so node tests them;
// renderCellContent is the only DOM writer. Each part lives in its own file under markdown/; this file is the one
// entry point the pages import.
export type { InlineNode, InlineOptions, LinkDefinition } from './markdown/inline.ts';
export { normalizeLabel, parseInline, plainTextOf } from './markdown/inline.ts';
export type { Alignment, Block, ListMarker } from './markdown/blocks.ts';
export { definitionOf, listMarkerOf, parseCellBlocks, quoteContentOf, THEMATIC_BREAK } from './markdown/blocks.ts';
export { parseDocumentBlocks } from './markdown/document.ts';
export type { DocumentIndex, IndexedBlock } from './markdown/document-index.ts';
export { documentIndexOf, slugOf } from './markdown/document-index.ts';
export type { LinkTarget } from './markdown/links.ts';
export { ANCHOR_ID_PREFIX, linkTargetOf } from './markdown/links.ts';
export type { RenderContext } from './markdown/render.ts';
export { renderCellContent, renderDocument } from './markdown/render.ts';
