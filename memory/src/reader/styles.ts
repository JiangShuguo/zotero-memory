export const SURFACE_STYLE_ID = "mem-surface-style";
export const TOOLBAR_STYLE_ID = "mem-toolbar-style";

export const SURFACE_CSS = `
.pdfViewer.mem-viewer {
  --mem-gutter: 304px;
  padding-inline-start: calc(18px + var(--mem-gutter)) !important;
  padding-inline-end: calc(18px + var(--mem-gutter)) !important;
}

.mem-overlay-root,
.mem-page-overlay,
.mem-lines,
.mem-cards,
.mem-column,
.mem-scroll,
.mem-column-body {
  pointer-events: none;
}

.mem-overlay-root,
.mem-page-overlay {
  position: absolute;
  overflow: visible;
}

.mem-overlay-root {
  top: 0;
  left: 0;
  width: 100%;
  height: 0;
  z-index: 90;
}

.mem-lines {
  position: absolute;
  top: 0;
  overflow: visible;
}

.mem-line {
  fill: none;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: .72;
  vector-effect: non-scaling-stroke;
  transition: opacity .14s ease, stroke-width .14s ease, filter .14s ease;
}

.mem-line-dot {
  stroke: white;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  transition: filter .14s ease;
}

.mem-line.mem-hovered {
  stroke-width: 2;
  opacity: .98;
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .28));
}

.mem-line-dot.mem-hovered {
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, .3));
}

.mem-cards {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.mem-column {
  position: absolute;
  top: 0;
  width: 264px;
  height: 100%;
  overflow: visible;
}

.mem-column-left { right: calc(100% + 24px); }
.mem-column-right { left: calc(100% + 24px); }

.mem-scroll {
  position: absolute;
  inset: 0;
  overflow: visible;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, CanvasText 32%, transparent) transparent;
}

.mem-column-body {
  position: relative;
  width: 100%;
  min-height: 100%;
}

.mem-column.mem-expanded .mem-scroll {
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}

.mem-expand {
  position: absolute;
  left: 0;
  z-index: 3;
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  border: 1px dashed color-mix(in srgb, CanvasText 32%, transparent);
  border-radius: 12px;
  background: Canvas;
  color: CanvasText;
  font: 12px/1.3 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  cursor: pointer;
  pointer-events: auto;
}

.mem-expand[hidden] { display: none; }

.mem-card {
  position: absolute;
  left: 0;
  box-sizing: border-box;
  width: 264px;
  min-height: 42px;
  padding: 8px 12px 7px;
  border: 2px solid var(--mem-color, #ffd400);
  border-radius: 12px;
  background: Canvas;
  color: CanvasText;
  font: 13px/1.65 "Palatino Linotype", Palatino, "Songti SC", "Noto Serif SC", PMingLiU, Georgia, serif;
  pointer-events: auto;
  transition: box-shadow .14s ease;
}

.mem-card.mem-hovered,
.mem-card.mem-active {
  box-shadow: 0 8px 18px rgba(0, 0, 0, .12);
}

.mem-card.mem-filtered,
.mem-card.mem-overflow-hidden {
  display: none;
}

.mem-preview,
.mem-editor {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 1px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1.65;
  text-align: start;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.mem-preview {
  display: -webkit-box;
  max-height: calc(3 * 1.65em);
  overflow: hidden;
  cursor: text;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

.mem-preview.mem-empty {
  color: color-mix(in srgb, CanvasText 48%, transparent);
  font-style: italic;
}

.mem-editor {
  display: none;
  min-height: 37px;
  max-height: 156px;
  overflow-y: auto;
  outline: none;
  cursor: text;
  user-select: text;
  -moz-user-select: text;
}

.mem-editor > div {
  margin: 0;
  padding: 0;
}

.mem-editor:empty::before {
  content: attr(data-placeholder);
  color: color-mix(in srgb, CanvasText 48%, transparent);
  font-style: italic;
  pointer-events: none;
}

.mem-card.mem-editing .mem-preview { display: none; }
.mem-card.mem-editing .mem-editor { display: block; }

.mem-bar { display: none; }

.mem-card.mem-editing .mem-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: -2px -2px 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  user-select: none;
  -moz-user-select: none;
}

.mem-bar button {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: CanvasText;
  font: 13px/1 "Palatino Linotype", Palatino, Georgia, serif;
  cursor: pointer;
  pointer-events: auto;
}

.mem-bar button > * { pointer-events: none; }

.mem-bar button.mem-size {
  width: auto;
  min-width: 26px;
  padding: 0 4px;
  font-family: "Segoe UI", "PingFang SC", sans-serif;
  font-size: 11px;
}

.mem-bar button.mem-on,
.mem-bar button:hover {
  background: color-mix(in srgb, CanvasText 10%, transparent);
}

.mem-bar .mem-sep {
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: color-mix(in srgb, CanvasText 16%, transparent);
}

.mem-bar svg { display: block; margin: 0 auto; }

.mem-editor ul,
.mem-preview ul {
  margin: .15em 0 .15em 1.15em;
  padding: 0;
}

.mem-editor::selection,
.mem-editor *::selection {
  background: Highlight !important;
  color: HighlightText !important;
}

.mem-footer {
  display: none;
  align-items: center;
  min-height: 16px;
  margin-top: 3px;
  color: color-mix(in srgb, CanvasText 55%, transparent);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 10px;
  letter-spacing: .04em;
}

.mem-card.mem-has-status .mem-footer { display: flex; }

.mem-status.mem-error { color: #c83c36; }

.mem-low-zoom .mem-card:not(.mem-editing) {
  min-height: 0;
  padding-top: 5px;
  padding-bottom: 5px;
}

.mem-low-zoom .mem-card:not(.mem-editing) .mem-preview {
  display: block;
  max-height: 1.65em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-color-scheme: dark) {
  .mem-card.mem-hovered,
  .mem-card.mem-active {
    box-shadow: 0 10px 22px rgba(0, 0, 0, .42);
  }
}
`;

export const TOOLBAR_CSS = `
.mem-toolbar-toggle svg {
  width: 20px;
  height: 20px;
  pointer-events: none;
}
.mem-toolbar-toggle.active {
  background: color-mix(in srgb, currentColor 13%, transparent) !important;
}
`;

export const NATIVE_HOVER_STYLE_ID = "mem-native-hover-style";

export const NATIVE_HOVER_CSS = `
[data-annotation-id].mem-native-hover {
  filter: brightness(.9) saturate(1.22) drop-shadow(0 1px 1.5px rgba(0, 0, 0, .28));
  scale: 1.018;
  transform-box: fill-box;
  transform-origin: center;
  transition: filter .14s ease, scale .14s ease;
}
`;
