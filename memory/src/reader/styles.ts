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

.mem-column {
  --mem-color: color-mix(in srgb, CanvasText 50%, transparent);
}

.mem-scroll {
  position: absolute;
  inset: 0;
  overflow: visible;
  scrollbar-width: none;
}

.mem-column-body {
  position: relative;
  width: 100%;
  min-height: 100%;
}

.mem-column.mem-overflowing .mem-scroll {
  overflow-x: hidden;
  overflow-y: auto;
  pointer-events: auto;
}

.mem-column.mem-overflowing .mem-scroll.mem-fade-top {
  mask-image: linear-gradient(to bottom, transparent 0, #000 28px);
}

.mem-column.mem-overflowing .mem-scroll.mem-fade-bottom {
  mask-image: linear-gradient(to top, transparent 0, #000 28px);
}

.mem-column.mem-overflowing .mem-scroll.mem-fade-top.mem-fade-bottom {
  mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%);
}

.mem-column > .mem-scrollbar { right: -12px; }

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

.mem-card.mem-filtered {
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
  display: block;
  cursor: text;
  user-select: text;
  -moz-user-select: text;
}

.mem-preview:focus { outline: none; }

.mem-preview,
.mem-editor {
  max-height: calc(9 * 1.65em);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* The drawn bar lives in the card's side padding; this keeps the text clear of it. */
  padding-inline-end: 4px;
  scrollbar-width: none;
}

.mem-scrollbar {
  position: absolute;
  right: 2px;
  display: flex;
  flex-direction: column;
  width: 8px;
  opacity: .35;
  transition: opacity .55s ease;
  user-select: none;
  -moz-user-select: none;
}

.mem-scrollbar[hidden] { display: none; }

.mem-scrollbar:hover,
.mem-scrollbar.mem-scrolling,
.mem-scrollbar.mem-dragging {
  opacity: 1;
}

.mem-scroll-arrow {
  flex: none;
  height: 9px;
  cursor: default;
}

.mem-scroll-arrow::before {
  content: "";
  display: block;
  width: 0;
  height: 0;
  margin: 2px auto 0;
  border-inline: 4px solid transparent;
  opacity: .7;
}

.mem-scroll-up::before { border-bottom: 5px solid var(--mem-color); }
.mem-scroll-down::before { border-top: 5px solid var(--mem-color); }
.mem-scroll-arrow:hover::before { opacity: 1; }

.mem-scroll-track {
  position: relative;
  flex: 1;
  margin: 2px 0;
}

.mem-scroll-thumb {
  position: absolute;
  top: 0;
  left: 1px;
  width: 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--mem-color) 65%, transparent);
  transition: background .14s ease;
}

.mem-scroll-thumb:hover,
.mem-scrollbar.mem-dragging .mem-scroll-thumb { background: var(--mem-color); }

.mem-low-zoom .mem-card:not(.mem-editing) .mem-scrollbar { display: none; }

.mem-preview.mem-empty {
  color: color-mix(in srgb, CanvasText 48%, transparent);
  font-style: italic;
}

.mem-editor {
  display: none;
  min-height: 37px;
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

.mem-color-menu {
  position: absolute;
  z-index: 6;
  display: grid;
  grid-template-columns: repeat(4, 28px);
  gap: 4px;
  padding: 6px;
  border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
  border-radius: 10px;
  background: Canvas;
  box-shadow: 0 8px 22px rgba(0, 0, 0, .14);
  pointer-events: auto;
  user-select: none;
  -moz-user-select: none;
}

.mem-color-menu.mem-with-names {
  grid-template-columns: repeat(2, max-content);
  gap: 2px 6px;
}

.mem-color-menu[hidden] { display: none; }

.mem-color-option {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: CanvasText;
  cursor: pointer;
}

.mem-color-menu.mem-with-names .mem-color-option {
  display: grid;
  grid-template-columns: 14px max-content 12px;
  gap: 6px;
  width: auto;
  min-height: 28px;
  padding: 4px 6px;
  justify-content: start;
  font: 12px/1.2 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: start;
}

.mem-color-option:hover,
.mem-color-option.mem-on {
  background: color-mix(in srgb, CanvasText 9%, transparent);
}

.mem-color-swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, CanvasText 18%, transparent);
}

.mem-color-menu.mem-with-names .mem-color-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

.mem-color-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mem-color-check {
  font-size: 12px;
  line-height: 1;
  text-align: center;
}

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

.mem-bar .mem-color-toggle svg {
  display: block;
  margin: 0 auto;
  fill: currentColor;
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
.mem-editor *::selection,
.mem-preview::selection,
.mem-preview *::selection {
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
  overflow-y: hidden;
  white-space: nowrap;
  padding-inline-end: 0;
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
