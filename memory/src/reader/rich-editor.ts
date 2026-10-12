import {
  clearFormat,
  formatState,
  parseComment,
  readDom,
  renderRich,
  serializeComment,
  setSize,
  textLength,
  toggleList,
  toggleMark,
  type DomReading,
  type FormatState,
  type Mark,
  type RichText,
  type Size,
  type TextRange,
} from "../markup/rich-text";

export type FormatCommand =
  | { kind: "mark"; mark: Mark }
  | { kind: "size"; size: Size }
  | { kind: "list" }
  | { kind: "clear" };

/** Binds the rich-text model to one contenteditable element. */
export class RichEditor {
  private remembered?: TextRange;

  constructor(readonly root: HTMLElement) {}

  load(stored: string): void {
    this.render(parseComment(stored));
    this.remembered = undefined;
  }

  value(): string {
    return serializeComment(readDom(this.root).rich);
  }

  /** Stores the current selection so that a toolbar action can still use it after focus moved. */
  rememberSelection(): void {
    const range = this.liveSelection(readDom(this.root));
    if (range) this.remembered = range;
  }

  /** Puts back the last selection seen inside the editor. */
  restoreSelection(): void {
    const reading = readDom(this.root);
    this.render(reading.rich, this.remembered ?? endOf(reading.rich));
  }

  apply(command: FormatCommand): void {
    const reading = readDom(this.root);
    const range = this.liveSelection(reading) ?? this.remembered ?? endOf(reading.rich);
    const next = transform(reading.rich, range, command);
    this.render(next, range);
  }

  state(): FormatState {
    const reading = readDom(this.root);
    const range = this.liveSelection(reading) ?? this.remembered ?? endOf(reading.rich);
    return formatState(reading.rich, range);
  }

  /** Re-renders the editor in canonical markup, keeping the caret where it was. */
  normalize(): void {
    const reading = readDom(this.root);
    const range = this.liveSelection(reading) ?? endOf(reading.rich);
    this.render(reading.rich, range);
  }

  selectAll(): void {
    const reading = readDom(this.root);
    this.render(reading.rich, { start: 0, end: textLength(reading.rich) });
  }

  caretToEnd(): void {
    const reading = readDom(this.root);
    this.render(reading.rich, endOf(reading.rich));
  }

  selectedText(): string {
    const range = this.liveSelection(readDom(this.root));
    if (!range || range.start === range.end) return "";
    return this.root.ownerDocument.getSelection()?.toString() ?? "";
  }

  hasSelection(): boolean {
    const range = this.liveSelection(readDom(this.root));
    return Boolean(range && range.start !== range.end);
  }

  private render(rich: RichText, range?: TextRange): void {
    const doc = this.root.ownerDocument;
    const rendering = renderRich(doc, rich, "editor");
    this.root.replaceChildren(rendering.fragment);
    if (!range) return;
    this.placeSelection(rendering.pointAt.bind(rendering), range);
  }

  private placeSelection(
    pointAt: (offset: number, affinity?: "before" | "after") => { node: Node; offset: number } | undefined,
    range: TextRange,
  ): void {
    const doc = this.root.ownerDocument;
    const selection = doc.getSelection();
    if (!selection) return;
    const collapsed = range.start === range.end;
    const start = pointAt(range.start, collapsed ? "before" : "after") ?? { node: this.root, offset: 0 };
    const end = collapsed ? start : pointAt(range.end, "before") ?? start;
    const domRange = doc.createRange();
    try {
      domRange.setStart(start.node, start.offset);
      domRange.setEnd(end.node, end.offset);
    } catch {
      domRange.selectNodeContents(this.root);
      domRange.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(domRange);
    this.remembered = { ...range };
  }

  private liveSelection(reading: DomReading): TextRange | undefined {
    const selection = this.root.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    if (!this.root.contains(range.startContainer) || !this.root.contains(range.endContainer)) return undefined;
    const start = reading.offsetOf(range.startContainer, range.startOffset);
    const end = reading.offsetOf(range.endContainer, range.endOffset);
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }
}

function transform(rich: RichText, range: TextRange, command: FormatCommand): RichText {
  switch (command.kind) {
    case "mark":
      return toggleMark(rich, range, command.mark);
    case "size":
      return setSize(rich, range, command.size);
    case "list":
      return toggleList(rich, range);
    case "clear":
      return clearFormat(rich, range);
  }
}

function endOf(rich: RichText): TextRange {
  const length = textLength(rich);
  return { start: length, end: length };
}
