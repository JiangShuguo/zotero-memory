/**
 * A small rich-text model for annotation comments.
 *
 * Comments are stored in Zotero as a restricted HTML subset:
 *   <b> <i> <u> <s> <sup> <sub> <span style="font-size:Npx"> <ul><li> and "\n" line breaks.
 *
 * Editing never relies on document.execCommand. The editor DOM is read into this model,
 * the model is transformed, and the editor is rendered again. Selections are kept as
 * linear offsets, where every line break counts as one character.
 */

export const SIZES = [11, 13, 15, 18] as const;
export type Size = (typeof SIZES)[number];
export const BASE_SIZE: Size = 13;

export const MARKS = ["b", "i", "u", "s", "sup", "sub"] as const;
export type Mark = (typeof MARKS)[number];

export interface Style {
  readonly marks: readonly Mark[];
  readonly size: Size;
}

export interface Run extends Style {
  readonly text: string;
  /** An empty run that only carries the style for the next typed character. */
  readonly caret?: boolean;
}

export interface Line {
  readonly list: boolean;
  readonly runs: readonly Run[];
}

export type RichText = readonly Line[];

export interface TextRange {
  start: number;
  end: number;
}

export interface FormatState {
  marks: ReadonlySet<Mark>;
  size?: Size;
  list: boolean;
}

export const PLAIN: Style = { marks: [], size: BASE_SIZE };

const ZWSP = "\u200b";
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const SIZE_SET = new Set<number>(SIZES);
const MARK_TAGS: Record<string, Mark> = {
  b: "b",
  strong: "b",
  i: "i",
  em: "i",
  u: "u",
  ins: "u",
  s: "s",
  strike: "s",
  del: "s",
  sup: "sup",
  sub: "sub",
};
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "table",
  "tr",
]);
const SKIPPED_TAGS = new Set(["head", "link", "meta", "noscript", "script", "style", "template", "title"]);

// ---------------------------------------------------------------------------
// Styles

export function makeStyle(marks: Iterable<Mark>, size: Size = BASE_SIZE): Style {
  const set = new Set(marks);
  return { marks: MARKS.filter((mark) => set.has(mark)), size };
}

export function sameStyle(left: Style, right: Style): boolean {
  return (
    left.size === right.size &&
    left.marks.length === right.marks.length &&
    left.marks.every((mark, index) => mark === right.marks[index])
  );
}

function withMark(style: Style, mark: Mark, on: boolean): Style {
  const set = new Set(style.marks);
  if (on) {
    if (mark === "sup") set.delete("sub");
    if (mark === "sub") set.delete("sup");
    set.add(mark);
  } else {
    set.delete(mark);
  }
  return makeStyle(set, style.size);
}

function withSize(style: Style, size: Size): Style {
  return { marks: style.marks, size };
}

interface Frame {
  marks: Mark[];
  size?: Size;
}

function styleOf(frames: readonly Frame[]): Style {
  let style = PLAIN;
  for (const frame of frames) {
    for (const mark of frame.marks) style = withMark(style, mark, true);
    if (frame.size) style = withSize(style, frame.size);
  }
  return style;
}

// ---------------------------------------------------------------------------
// Building lines (shared by the stored-string parser and the DOM reader)

class LineBuilder {
  readonly lines: Array<{ list: boolean; runs: Run[] }> = [];
  list = false;
  private current?: { list: boolean; runs: Run[] };
  private start = 0;

  /** Linear offset of the next character that would be written. */
  cursor(): number {
    if (this.current) return this.start + runsLength(this.current.runs);
    const last = this.lines[this.lines.length - 1];
    return last ? this.start + runsLength(last.runs) + 1 : 0;
  }

  /** Ends the current block; the next content starts a new line. */
  endBlock(): void {
    this.current = undefined;
  }

  /** A <br>: closes the current line, creating it when it is still empty. */
  lineBreak(): void {
    this.line();
    this.current = undefined;
  }

  /** Writes text; "\n" starts a new line. Returns the offset before each UTF-16 unit and at the end. */
  text(raw: string, style: Style): number[] {
    const offsets: number[] = [];
    let line = this.line();
    let buffer = "";
    let real = false;
    const flush = () => {
      if (!buffer) return;
      appendRun(line.runs, { ...style, text: buffer });
      buffer = "";
    };
    for (let index = 0; index < raw.length; index += 1) {
      offsets.push(this.start + runsLength(line.runs) + buffer.length);
      const char = raw[index]!;
      if (char === ZWSP) continue;
      if (char === "\r" && raw[index + 1] === "\n") continue;
      if (char === "\n" || char === "\r") {
        flush();
        this.current = undefined;
        line = this.line();
        real = true;
        continue;
      }
      buffer += char;
      real = true;
    }
    flush();
    if (raw.length && !real) line.runs.push({ ...style, text: "", caret: true });
    offsets.push(this.start + runsLength(line.runs));
    return offsets;
  }

  private line(): { list: boolean; runs: Run[] } {
    if (!this.current) {
      const previous = this.lines[this.lines.length - 1];
      this.start = previous ? this.start + runsLength(previous.runs) + 1 : 0;
      this.current = { list: this.list, runs: [] };
      this.lines.push(this.current);
    }
    return this.current;
  }
}

function appendRun(runs: Run[], run: Run): void {
  const last = runs[runs.length - 1];
  if (last && !last.caret && !run.caret && sameStyle(last, run)) {
    runs[runs.length - 1] = { ...last, text: last.text + run.text };
  } else {
    runs.push(run);
  }
}

function runsLength(runs: readonly Run[]): number {
  let length = 0;
  for (const run of runs) length += run.text.length;
  return length;
}

export function lineLength(line: Line): number {
  return runsLength(line.runs);
}

export function textLength(rich: RichText): number {
  let length = 0;
  rich.forEach((line, index) => {
    length += lineLength(line) + (index ? 1 : 0);
  });
  return length;
}

// ---------------------------------------------------------------------------
// Stored comment <-> model

export function parseComment(stored: string): RichText {
  const builder = new LineBuilder();
  const frames: Array<{ name: string; frame: Frame }> = [];
  const lists: boolean[] = [];
  const write = (text: string) => {
    if (text) builder.text(text, styleOf(frames.map((entry) => entry.frame)));
  };
  let cursor = 0;
  while (cursor < stored.length) {
    const open = stored.indexOf("<", cursor);
    if (open < 0) {
      write(stored.slice(cursor));
      break;
    }
    write(stored.slice(cursor, open));
    const close = stored.indexOf(">", open + 1);
    const token = close < 0 || close - open > 80 ? undefined : readTag(stored.slice(open + 1, close));
    if (!token) {
      write("<");
      cursor = open + 1;
      continue;
    }
    cursor = close + 1;
    const { name, closing } = token;
    if (name === "br") {
      builder.lineBreak();
    } else if (name === "ul" || name === "ol") {
      builder.endBlock();
    } else if (name === "li") {
      builder.endBlock();
      if (closing) {
        builder.list = lists.pop() ?? false;
      } else {
        lists.push(builder.list);
        builder.list = true;
      }
    } else if (closing) {
      const index = findLastIndex(frames, (entry) => entry.name === name);
      if (index >= 0) frames.splice(index);
    } else {
      frames.push({ name, frame: token.frame });
    }
  }
  return trimLines(builder.lines);
}

interface Tag {
  name: string;
  closing: boolean;
  frame: Frame;
}

function readTag(body: string): Tag | undefined {
  const match = /^\s*(\/?)\s*([a-z]+)\s*([^>]*?)\s*\/?\s*$/i.exec(body);
  if (!match) return undefined;
  const closing = match[1] === "/";
  const name = match[2]!.toLowerCase();
  const rest = match[3] ?? "";
  if (name === "br" || name === "ul" || name === "ol" || name === "li") {
    return rest && !closing ? undefined : { name, closing, frame: { marks: [] } };
  }
  const mark = MARK_TAGS[name];
  if (mark) return rest ? undefined : { name, closing, frame: { marks: [mark] } };
  if (name !== "span") return undefined;
  if (closing) return rest ? undefined : { name, closing, frame: { marks: [] } };
  const size = /^style\s*=\s*"\s*font-size\s*:\s*(\d+)px\s*;?\s*"$/i.exec(rest);
  if (!size || !SIZE_SET.has(Number(size[1]))) return undefined;
  return { name, closing, frame: { marks: [], size: Number(size[1]) as Size } };
}

export function serializeComment(rich: RichText): string {
  let out = "";
  let inList = false;
  rich.forEach((line, index) => {
    const body = serializeRuns(line.runs);
    if (line.list) {
      if (!inList) out += "<ul>";
      inList = true;
      out += `<li>${body}</li>`;
      return;
    }
    if (inList) out += "</ul>";
    else if (index) out += "\n";
    inList = false;
    out += body;
  });
  if (inList) out += "</ul>";
  return out.trim();
}

function serializeRuns(runs: readonly Run[]): string {
  let out = "";
  for (const run of mergeRuns(runs)) {
    if (!run.text) continue;
    const tags: string[] = [];
    if (run.size !== BASE_SIZE) tags.push(`span style="font-size:${run.size}px"`);
    tags.push(...run.marks);
    out += tags.map((tag) => `<${tag}>`).join("");
    out += run.text;
    out += tags
      .map((tag) => `</${tag.split(" ")[0]}>`)
      .reverse()
      .join("");
  }
  return out;
}

function mergeRuns(runs: readonly Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    appendRun(merged, run);
  }
  return merged;
}

function trimLines(lines: Array<{ list: boolean; runs: Run[] }>): RichText {
  return lines.map((line) => ({ list: line.list, runs: line.runs }));
}

// ---------------------------------------------------------------------------
// Editor DOM -> model

export interface DomReading {
  rich: RichText;
  offsetOf(node: Node, offset: number): number;
}

export function readDom(root: Node): DomReading {
  const builder = new LineBuilder();
  const textOffsets = new Map<Node, number[]>();
  const boundaries = new Map<Node, number[]>();

  const visit = (node: Node, frames: Frame[]): void => {
    if (node.nodeType === TEXT_NODE) {
      const data = (node as Text).data;
      const parentTag = (node.parentNode as Element | null)?.localName?.toLowerCase();
      if ((parentTag === "ul" || parentTag === "ol") && !data.trim()) return;
      textOffsets.set(node, builder.text(data, styleOf(frames)));
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === "br") {
      builder.lineBreak();
      return;
    }
    const isItem = tag === "li";
    const isBlock = isItem || tag === "ul" || tag === "ol" || BLOCK_TAGS.has(tag);
    const savedList = builder.list;
    if (isBlock) builder.endBlock();
    if (isItem) builder.list = true;
    visitChildren(element, frames.concat(frameOf(element, tag)));
    if (isBlock) builder.endBlock();
    if (isItem) builder.list = savedList;
  };

  const visitChildren = (parent: Node, frames: Frame[]): void => {
    const marks: number[] = [];
    const children = parent.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      marks.push(builder.cursor());
      const child = children[index];
      if (child) visit(child, frames);
    }
    marks.push(builder.cursor());
    boundaries.set(parent, marks);
  };

  visitChildren(root, []);
  const rich = trimLines(builder.lines);
  const total = textLength(rich);
  const clampOffset = (value: number) => Math.max(0, Math.min(total, value));

  const offsetOf = (node: Node, offset: number): number => {
    const text = textOffsets.get(node);
    if (text) return clampOffset(text[Math.max(0, Math.min(text.length - 1, offset))] ?? 0);
    const marks = boundaries.get(node);
    if (marks) return clampOffset(marks[Math.max(0, Math.min(marks.length - 1, offset))] ?? 0);
    let child: Node = node;
    while (child.parentNode) {
      const parent: Node = child.parentNode;
      const parentMarks = boundaries.get(parent);
      if (parentMarks) {
        const index = Array.prototype.indexOf.call(parent.childNodes, child) as number;
        return clampOffset(parentMarks[Math.max(0, index)] ?? 0);
      }
      child = parent;
    }
    return 0;
  };

  return { rich, offsetOf };
}

function frameOf(element: Element, tag: string): Frame {
  const marks: Mark[] = [];
  const mark = MARK_TAGS[tag];
  if (mark) marks.push(mark);
  let size: Size | undefined;
  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (style) {
    const fontSize = /^(\d+(?:\.\d+)?)px$/.exec(style.fontSize ?? "");
    if (fontSize && SIZE_SET.has(Number(fontSize[1]))) size = Number(fontSize[1]) as Size;
    const weight = style.fontWeight ?? "";
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) marks.push("b");
    if (/italic|oblique/.test(style.fontStyle ?? "")) marks.push("i");
    const decoration = `${style.textDecoration ?? ""} ${style.textDecorationLine ?? ""}`;
    if (decoration.includes("underline")) marks.push("u");
    if (decoration.includes("line-through")) marks.push("s");
    const align = style.verticalAlign ?? "";
    if (align === "super") marks.push("sup");
    if (align === "sub") marks.push("sub");
  }
  return { marks, size };
}

// ---------------------------------------------------------------------------
// Model -> DOM

export interface Rendering {
  fragment: DocumentFragment;
  /** A DOM point for a linear offset, or undefined when the rendering has no text position. */
  pointAt(offset: number, affinity?: "before" | "after"): { node: Node; offset: number } | undefined;
}

interface TextSpot {
  start: number;
  end: number;
  node: Text;
  caret: boolean;
}

interface EmptySpot {
  start: number;
  container: Element;
}

/**
 * Renders the model. "editor" keeps one block element per line so that a caret can live
 * on an empty line; "preview" uses <br> between lines so that line clamping still works.
 */
export function renderRich(doc: Document, rich: RichText, mode: "editor" | "preview"): Rendering {
  const fragment = doc.createDocumentFragment();
  const spots: TextSpot[] = [];
  const empties: EmptySpot[] = [];
  let list: HTMLElement | undefined;
  let offset = 0;

  rich.forEach((line, index) => {
    if (index) offset += 1;
    let host: Node;
    if (line.list) {
      if (!list) {
        list = doc.createElement("ul");
        fragment.append(list);
      }
      host = list.appendChild(doc.createElement("li"));
    } else {
      list = undefined;
      if (mode === "editor") {
        host = fragment.appendChild(doc.createElement("div"));
      } else {
        const previous = rich[index - 1];
        if (previous && !previous.list) fragment.append(doc.createElement("br"));
        host = fragment;
      }
    }
    const empty = !line.runs.some((run) => run.text || run.caret);
    if (empty) {
      if (host !== fragment) {
        host.appendChild(doc.createElement("br"));
        empties.push({ start: offset, container: host as Element });
      }
      return;
    }
    for (const run of line.runs) {
      if (!run.text && !run.caret) continue;
      const text = doc.createTextNode(run.text || ZWSP);
      host.appendChild(wrap(doc, run, text));
      spots.push({ start: offset, end: offset + run.text.length, node: text, caret: Boolean(run.caret) });
      offset += run.text.length;
    }
  });

  const pointAt = (target: number, affinity: "before" | "after" = "before") => {
    const caret = spots.find((spot) => spot.caret && spot.start === target);
    if (caret) return { node: caret.node as Node, offset: 1 };
    const inside = spots.filter((spot) => !spot.caret && spot.start <= target && target <= spot.end);
    const preferred =
      affinity === "before"
        ? inside.find((spot) => spot.start < target) ?? inside[0]
        : inside.find((spot) => target < spot.end) ?? inside[inside.length - 1];
    if (preferred) return { node: preferred.node as Node, offset: target - preferred.start };
    const empty = empties.find((spot) => spot.start === target);
    if (empty) return { node: empty.container as Node, offset: 0 };
    const last = spots[spots.length - 1];
    if (last && target >= last.end) return { node: last.node as Node, offset: last.caret ? 1 : last.node.data.length };
    const lastEmpty = empties[empties.length - 1];
    if (lastEmpty) return { node: lastEmpty.container as Node, offset: 0 };
    return undefined;
  };

  return { fragment, pointAt };
}

function wrap(doc: Document, style: Style, content: Node): Node {
  let node = content;
  for (const mark of [...style.marks].reverse()) {
    const element = doc.createElement(mark);
    element.append(node);
    node = element;
  }
  if (style.size !== BASE_SIZE) {
    const span = doc.createElement("span");
    span.style.fontSize = `${style.size}px`;
    span.append(node);
    node = span;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Editing operations

interface Cell {
  char: string;
  style: Style;
}

interface Located {
  line: number;
  column: number;
}

function locate(rich: RichText, offset: number): Located {
  let start = 0;
  for (let line = 0; line < rich.length; line += 1) {
    const length = lineLength(rich[line]!);
    if (offset <= start + length || line === rich.length - 1) {
      return { line, column: Math.max(0, Math.min(length, offset - start)) };
    }
    start += length + 1;
  }
  return { line: 0, column: 0 };
}

function cellsOf(line: Line): Cell[] {
  const cells: Cell[] = [];
  for (const run of line.runs) {
    for (const char of run.text) cells.push({ char, style: makeStyle(run.marks, run.size) });
  }
  return cells;
}

function runsOf(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  for (const cell of cells) appendRun(runs, { ...cell.style, text: cell.char });
  return runs;
}

/** The selected column span of every line touched by the range. */
function spans(rich: RichText, range: TextRange): Array<{ line: number; from: number; to: number }> {
  const result: Array<{ line: number; from: number; to: number }> = [];
  const low = Math.min(range.start, range.end);
  const high = Math.max(range.start, range.end);
  let start = 0;
  rich.forEach((line, index) => {
    const length = lineLength(line);
    const end = start + length;
    if (high >= start && low <= end) {
      result.push({ line: index, from: Math.max(0, low - start), to: Math.min(length, high - start) });
    }
    start = end + 1;
  });
  return result;
}

function dropCarets(rich: RichText): Line[] {
  return rich.map((line) =>
    line.runs.some((run) => run.caret) ? { list: line.list, runs: line.runs.filter((run) => !run.caret) } : line,
  );
}

/** The style a character typed at `offset` would get. */
export function styleAt(rich: RichText, offset: number): Style {
  if (!rich.length) return PLAIN;
  const { line, column } = locate(rich, offset);
  let position = 0;
  let before: Style | undefined;
  let after: Style | undefined;
  for (const run of rich[line]!.runs) {
    if (run.caret && position === column) return makeStyle(run.marks, run.size);
    if (!run.text) continue;
    if (position < column && column <= position + run.text.length) before = run;
    if (!after && position >= column) after = run;
    position += run.text.length;
  }
  const chosen = before ?? after;
  return chosen ? makeStyle(chosen.marks, chosen.size) : PLAIN;
}

function insertCaret(rich: Line[], offset: number, style: Style): Line[] {
  if (!rich.length) return [{ list: false, runs: [{ ...style, text: "", caret: true }] }];
  if (sameStyle(style, styleAt(rich, offset))) return rich;
  const { line, column } = locate(rich, offset);
  const target = rich[line]!;
  const runs: Run[] = [];
  let position = 0;
  let placed = false;
  for (const run of target.runs) {
    const length = run.text.length;
    if (!placed && column <= position + length && (column > position || column === 0)) {
      const cut = column - position;
      if (cut > 0) runs.push({ ...run, text: run.text.slice(0, cut) });
      runs.push({ ...style, text: "", caret: true });
      if (cut < length) runs.push({ ...run, text: run.text.slice(cut) });
      placed = true;
    } else {
      runs.push(run);
    }
    position += length;
  }
  if (!placed) runs.push({ ...style, text: "", caret: true });
  const next = rich.slice();
  next[line] = { list: target.list, runs };
  return next;
}

function restyle(rich: RichText, range: TextRange, change: (style: Style) => Style): Line[] {
  const next = dropCarets(rich);
  for (const { line, from, to } of spans(next, range)) {
    if (from === to) continue;
    const cells = cellsOf(next[line]!);
    for (let column = from; column < to; column += 1) {
      cells[column] = { char: cells[column]!.char, style: change(cells[column]!.style) };
    }
    next[line] = { list: next[line]!.list, runs: runsOf(cells) };
  }
  return next;
}

function selectedCells(rich: RichText, range: TextRange): Cell[] {
  const cells: Cell[] = [];
  for (const { line, from, to } of spans(rich, range)) {
    cells.push(...cellsOf(rich[line]!).slice(from, to));
  }
  return cells;
}

export function toggleMark(rich: RichText, range: TextRange, mark: Mark): RichText {
  if (range.start === range.end) {
    const current = styleAt(rich, range.start);
    return insertCaret(dropCarets(rich), range.start, withMark(current, mark, !current.marks.includes(mark)));
  }
  const cells = selectedCells(rich, range);
  if (!cells.length) return rich;
  const on = !cells.every((cell) => cell.style.marks.includes(mark));
  return restyle(rich, range, (style) => withMark(style, mark, on));
}

export function setSize(rich: RichText, range: TextRange, size: Size): RichText {
  if (range.start === range.end) {
    return insertCaret(dropCarets(rich), range.start, withSize(styleAt(rich, range.start), size));
  }
  return restyle(rich, range, (style) => withSize(style, size));
}

export function clearFormat(rich: RichText, range: TextRange): RichText {
  if (range.start === range.end) {
    return insertCaret(dropCarets(rich), range.start, PLAIN);
  }
  return restyle(rich, range, () => PLAIN);
}

/** Lines a list toggle applies to: a selection that only reaches the start of a line leaves that line out. */
function touchedLines(rich: RichText, range: TextRange): number[] {
  const all = spans(rich, range);
  if (range.start === range.end) return all.map((span) => span.line);
  const real = all.filter((span, index) => !(index > 0 && span.from === 0 && span.to === 0));
  return real.map((span) => span.line);
}

export function toggleList(rich: RichText, range: TextRange): RichText {
  const next: Line[] = rich.length ? dropCarets(rich) : [{ list: false, runs: [] }];
  const touched = touchedLines(next, range);
  if (!touched.length) return next;
  const on = !touched.every((line) => next[line]!.list);
  for (const line of touched) next[line] = { list: on, runs: next[line]!.runs };
  return next;
}

export function formatState(rich: RichText, range: TextRange): FormatState {
  const touched = touchedLines(rich, range);
  const list = touched.length > 0 && touched.every((line) => rich[line]!.list);
  if (range.start === range.end) {
    const style = styleAt(rich, range.start);
    return { marks: new Set(style.marks), size: style.size, list };
  }
  const cells = selectedCells(rich, range);
  if (!cells.length) {
    const style = styleAt(rich, range.start);
    return { marks: new Set(style.marks), size: style.size, list };
  }
  const marks = new Set<Mark>(MARKS.filter((mark) => cells.every((cell) => cell.style.marks.includes(mark))));
  const size = cells.every((cell) => cell.style.size === cells[0]!.style.size) ? cells[0]!.style.size : undefined;
  return { marks, size, list };
}

function findLastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (test(items[index]!)) return index;
  }
  return -1;
}
