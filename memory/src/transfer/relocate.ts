/**
 * Finds where an annotation belongs in a PDF that is not byte-identical to the one it
 * was made on: text annotations by their text, everything else by nearby text.
 */
import type { PdfChar, PdfPageText, PdfText } from "./pdf-text";

export interface DocIndex {
  doc: PdfText;
  /** Letters and digits only, lower-cased, accents stripped. */
  stream: string;
  /** For each stream position: page index and char index on that page. */
  pageOf: Int32Array;
  charOf: Int32Array;
  pageStart: number[];
}

export interface TextAnchor {
  prefix?: string;
  suffix?: string;
}

export interface PointAnchor {
  context: string;
  contextOffset: number;
  dx: number;
  dy: number;
}

export interface LocateHint extends TextAnchor {
  pageIndex: number;
  sourcePageCount?: number;
  /** Distance of the annotation's top from the page top, as a fraction of page height. */
  top?: number;
}

export interface Match {
  start: number;
  end: number;
  quality: number;
  score: number;
}

export interface TextPlacement {
  position: { pageIndex: number; rects: number[][]; nextPageRects?: number[][] };
  text: string;
  sortIndex: string;
  pageLabel: string;
}

const CONTEXT_CHARS = 32;
const POINT_CONTEXT_CHARS = 24;
const SEED_CHARS = 12;
const MIN_QUALITY = 0.8;
const MAX_FUZZY_CHARS = 2000;
const MAX_CANDIDATES = 200;

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function indexDocument(doc: PdfText): DocIndex {
  const parts: string[] = [];
  const pages: number[] = [];
  const chars: number[] = [];
  const pageStart: number[] = [];
  let length = 0;
  for (const page of doc.pages) {
    pageStart[page.pageIndex] = length;
    page.chars.forEach((char, charIndex) => {
      if (char.ignorable) return;
      const norm = normalize(char.c);
      for (let k = 0; k < norm.length; k++) {
        parts.push(norm[k]);
        pages.push(page.pageIndex);
        chars.push(charIndex);
        length += 1;
      }
    });
  }
  pageStart[doc.pageCount] = length;
  return {
    doc,
    stream: parts.join(""),
    pageOf: Int32Array.from(pages),
    charOf: Int32Array.from(chars),
    pageStart,
  };
}

// ---------------------------------------------------------------------------
// Export side: anchors recorded on the source PDF

/** Context around the source occurrence of a text annotation. */
export function textAnchorAt(index: DocIndex, text: string, pageIndex: number, rects: number[][]): TextAnchor | undefined {
  const needle = normalize(text);
  if (!needle) return undefined;
  const target = rects.length ? topLeft(rects) : undefined;
  let best: { start: number; distance: number } | undefined;
  for (const start of occurrences(index.stream, needle, MAX_CANDIDATES)) {
    if (index.pageOf[start] !== pageIndex) continue;
    const rect = charRect(index, start);
    const distance = target && rect ? Math.hypot(rect[0] - target[0], rect[3] - target[1]) : 0;
    if (!best || distance < best.distance) best = { start, distance };
  }
  if (!best) return undefined;
  const end = best.start + needle.length;
  return {
    prefix: index.stream.slice(Math.max(0, best.start - CONTEXT_CHARS), best.start),
    suffix: index.stream.slice(end, end + CONTEXT_CHARS),
  };
}

/** The text nearest to `point` on the page, plus the offset from that text to the point. */
export function pointAnchorAt(index: DocIndex, pageIndex: number, point: [number, number]): PointAnchor | undefined {
  const from = index.pageStart[pageIndex];
  const to = nextPageStart(index, pageIndex);
  if (from === undefined || to <= from) return undefined;
  let nearest = -1;
  let nearestDistance = Infinity;
  for (let s = from; s < to; s++) {
    const rect = charRect(index, s);
    if (!rect) continue;
    const distance = distanceToRect(point, rect);
    if (distance < nearestDistance) {
      nearest = s;
      nearestDistance = distance;
    }
  }
  if (nearest < 0) return undefined;
  const start = Math.max(from, nearest - POINT_CONTEXT_CHARS);
  const end = Math.min(to, nearest + POINT_CONTEXT_CHARS);
  const rect = charRect(index, nearest)!;
  return {
    context: index.stream.slice(start, end),
    contextOffset: nearest - start,
    dx: point[0] - rect[0],
    dy: point[1] - rect[3],
  };
}

// ---------------------------------------------------------------------------
// Import side

/** Best place for `text` in the target document, or undefined when it cannot be found reliably. */
export function locateText(index: DocIndex, text: string, hint: LocateHint): Match | undefined {
  const needle = normalize(text);
  if (!needle) return undefined;
  const candidates = exactMatches(index, needle);
  if (!candidates.length && needle.length >= SEED_CHARS) candidates.push(...fuzzyMatches(index, needle));
  let best: Match | undefined;
  for (const candidate of candidates) {
    candidate.score = score(index, candidate, needle, hint);
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best || best.quality < MIN_QUALITY) return undefined;
  if (needle.length < 8 && !shortMatchTrusted(index, best, hint)) return undefined;
  return best;
}

/** Rects, text and sort key for the matched range, shaped like the reader's own highlights. */
export function placeText(index: DocIndex, match: Match, originalText: string): TextPlacement | undefined {
  const firstPage = index.pageOf[match.start];
  const lastPage = index.pageOf[match.end - 1];
  if (lastPage - firstPage > 1) return undefined;
  let from = index.charOf[match.start];
  let to = index.charOf[match.end - 1];
  const first = pageText(index, firstPage);
  const last = pageText(index, lastPage);
  if (!first || !last) return undefined;
  from = extendBackward(first.chars, from, leadingPunctuation(originalText));
  to = extendForward(last.chars, to, trailingPunctuation(originalText));

  const pieces: Array<{ page: PdfPageText; from: number; to: number }> = [];
  if (firstPage === lastPage) {
    pieces.push({ page: first, from, to });
  } else {
    pieces.push({ page: first, from, to: first.chars.length - 1 });
    pieces.push({ page: last, from: 0, to });
  }
  const rects = pieces.map((piece) => rangeRects(piece.page.chars, piece.from, piece.to));
  if (!rects[0].length) return undefined;
  const position: TextPlacement["position"] = { pageIndex: firstPage, rects: rects[0] };
  if (rects[1]?.length) position.nextPageRects = rects[1];
  const text = pieces.map((piece) => textFromChars(piece.page.chars.slice(piece.from, piece.to + 1))).join(" ");
  return {
    position,
    text,
    sortIndex: sortIndex(first, from, rects[0]),
    pageLabel: first.label,
  };
}

/** Where to put a non-text annotation whose reference point sits next to `anchor.context`. */
export function locatePoint(
  index: DocIndex,
  anchor: PointAnchor,
  hint: LocateHint,
): { pageIndex: number; point: [number, number]; charIndex: number } | undefined {
  const match = locateText(index, anchor.context, hint);
  if (!match) return undefined;
  const s = Math.min(match.end - 1, Math.max(match.start, match.start + anchor.contextOffset));
  const rect = charRect(index, s);
  if (!rect) return undefined;
  return {
    pageIndex: index.pageOf[s],
    point: [rect[0] + anchor.dx, rect[3] + anchor.dy],
    charIndex: index.charOf[s],
  };
}

export function sortIndex(page: PdfPageText, offset: number, rects: number[][]): string {
  const topRect = rects.reduce((best, rect) => (rect[3] > best[3] ? rect : best), rects[0]);
  const pageHeight = page.viewBox[3] - page.viewBox[1];
  const top = Math.max(0, pageHeight - (topRect?.[3] ?? pageHeight));
  return [
    String(page.pageIndex).slice(0, 5).padStart(5, "0"),
    String(Math.max(0, offset)).slice(0, 6).padStart(6, "0"),
    String(Math.floor(top)).slice(0, 5).padStart(5, "0"),
  ].join("|");
}

export function pageText(index: DocIndex, pageIndex: number): PdfPageText | undefined {
  const page = index.doc.pages[pageIndex];
  return page?.pageIndex === pageIndex ? page : index.doc.pages.find((entry) => entry.pageIndex === pageIndex);
}

export function topLeft(rects: number[][]): [number, number] {
  let x = Infinity;
  let y = -Infinity;
  for (const rect of rects) {
    x = Math.min(x, rect[0], rect[2]);
    y = Math.max(y, rect[1], rect[3]);
  }
  return [x, y];
}

// ---------------------------------------------------------------------------

function exactMatches(index: DocIndex, needle: string): Match[] {
  return occurrences(index.stream, needle, MAX_CANDIDATES).map((start) => ({
    start,
    end: start + needle.length,
    quality: 1,
    score: 0,
  }));
}

/** Seeds from several spots in the needle, then a free-ends edit-distance alignment around each. */
function fuzzyMatches(index: DocIndex, needle: string): Match[] {
  if (needle.length > MAX_FUZZY_CHARS) return [];
  const n = needle.length;
  const k = Math.min(SEED_CHARS, n);
  const slack = Math.ceil(n * 0.2) + 4;
  const offsets = [...new Set([0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - k])];
  const maxWindows = n > 600 ? 8 : 40;
  const windows = new Set<number>();
  for (const offset of offsets) {
    const seed = needle.slice(offset, offset + k);
    for (const at of occurrences(index.stream, seed, 30)) {
      if (windows.size >= maxWindows) break;
      windows.add(Math.max(0, at - offset - slack));
    }
  }
  const matches: Match[] = [];
  const seen = new Set<string>();
  for (const windowStart of windows) {
    const windowEnd = Math.min(index.stream.length, windowStart + n + 2 * slack);
    const aligned = align(needle, index.stream.slice(windowStart, windowEnd));
    if (!aligned) continue;
    const start = windowStart + aligned.start;
    const end = windowStart + aligned.end;
    const key = `${start}:${end}`;
    if (seen.has(key) || end <= start) continue;
    seen.add(key);
    matches.push({ start, end, quality: 1 - aligned.cost / n, score: 0 });
  }
  return matches;
}

/** Semi-global Levenshtein: the whole needle against any substring of `hay`. */
function align(needle: string, hay: string): { start: number; end: number; cost: number } | undefined {
  const m = hay.length;
  if (!m) return undefined;
  let prev = new Int32Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let curStart = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prevStart[j] = j;
  for (let i = 1; i <= needle.length; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const c = needle.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      let cost = prev[j - 1] + (hay.charCodeAt(j - 1) === c ? 0 : 1);
      let start = prevStart[j - 1];
      if (prev[j] + 1 < cost) {
        cost = prev[j] + 1;
        start = prevStart[j];
      }
      if (cur[j - 1] + 1 < cost) {
        cost = cur[j - 1] + 1;
        start = curStart[j - 1];
      }
      cur[j] = cost;
      curStart[j] = start;
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let end = 0;
  for (let j = 1; j <= m; j++) if (prev[j] < prev[end]) end = j;
  return { start: prevStart[end], end, cost: prev[end] };
}

function score(index: DocIndex, match: Match, needle: string, hint: LocateHint): number {
  let context = 0;
  let parts = 0;
  if (hint.prefix) {
    const before = index.stream.slice(Math.max(0, match.start - hint.prefix.length), match.start);
    context += commonSuffix(before, hint.prefix) / hint.prefix.length;
    parts += 1;
  }
  if (hint.suffix) {
    const after = index.stream.slice(match.end, match.end + hint.suffix.length);
    context += commonPrefix(after, hint.suffix) / hint.suffix.length;
    parts += 1;
  }
  if (parts) context /= parts;
  const page = index.pageOf[match.start];
  const pageDistance = Math.min(20, Math.abs(page - expectedPage(index, hint)));
  let topDistance = 0;
  if (hint.top !== undefined) {
    const top = topFraction(index, match.start);
    if (top !== undefined) topDistance = Math.abs(top - hint.top);
  }
  const lengthPenalty = Math.abs(match.end - match.start - needle.length) / Math.max(needle.length, 1);
  return match.quality * 4 + context * 3 - pageDistance * 0.3 - topDistance * 0.8 - lengthPenalty;
}

function shortMatchTrusted(index: DocIndex, match: Match, hint: LocateHint): boolean {
  if (hint.prefix || hint.suffix) {
    const before = index.stream.slice(Math.max(0, match.start - (hint.prefix?.length ?? 0)), match.start);
    const after = index.stream.slice(match.end, match.end + (hint.suffix?.length ?? 0));
    const shared = commonSuffix(before, hint.prefix ?? "") + commonPrefix(after, hint.suffix ?? "");
    if (shared >= 8) return true;
  }
  return index.pageOf[match.start] === Math.round(expectedPage(index, hint));
}

function expectedPage(index: DocIndex, hint: LocateHint): number {
  const count = index.doc.pageCount;
  if (hint.sourcePageCount && hint.sourcePageCount > 1 && count > 1 && hint.sourcePageCount !== count) {
    return (hint.pageIndex * (count - 1)) / (hint.sourcePageCount - 1);
  }
  return hint.pageIndex;
}

function topFraction(index: DocIndex, s: number): number | undefined {
  const page = pageText(index, index.pageOf[s]);
  const rect = charRect(index, s);
  if (!page || !rect) return undefined;
  const height = page.viewBox[3] - page.viewBox[1];
  return height > 0 ? (page.viewBox[3] - rect[3]) / height : undefined;
}

function charRect(index: DocIndex, s: number): number[] | undefined {
  const page = pageText(index, index.pageOf[s]);
  return page?.chars[index.charOf[s]]?.rect;
}

function nextPageStart(index: DocIndex, pageIndex: number): number {
  for (let p = pageIndex + 1; p <= index.doc.pageCount; p++) {
    if (index.pageStart[p] !== undefined) return index.pageStart[p];
  }
  return index.stream.length;
}

function occurrences(hay: string, needle: string, limit: number): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let at = hay.indexOf(needle);
  while (at >= 0 && out.length < limit) {
    out.push(at);
    at = hay.indexOf(needle, at + 1);
  }
  return out;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function distanceToRect(point: [number, number], rect: number[]): number {
  const x1 = Math.min(rect[0], rect[2]);
  const x2 = Math.max(rect[0], rect[2]);
  const y1 = Math.min(rect[1], rect[3]);
  const y2 = Math.max(rect[1], rect[3]);
  const dx = point[0] < x1 ? x1 - point[0] : point[0] > x2 ? point[0] - x2 : 0;
  const dy = point[1] < y1 ? y1 - point[1] : point[1] > y2 ? point[1] - y2 : 0;
  return Math.hypot(dx, dy);
}

function leadingPunctuation(text: string): number {
  const match = /^\s*([^\p{L}\p{N}\s]*)/u.exec(text);
  return match?.[1]?.length ?? 0;
}

function trailingPunctuation(text: string): number {
  const match = /([^\p{L}\p{N}\s]*)\s*$/u.exec(text);
  return match?.[1]?.length ?? 0;
}

function isPunctuation(char: PdfChar | undefined): boolean {
  return Boolean(char) && !char!.ignorable && Boolean(char!.c.trim()) && !normalize(char!.c);
}

function extendBackward(chars: PdfChar[], from: number, count: number): number {
  while (count > 0 && from > 0 && isPunctuation(chars[from - 1]) && !chars[from - 1].lineBreakAfter) {
    from -= 1;
    count -= 1;
  }
  return from;
}

function extendForward(chars: PdfChar[], to: number, count: number): number {
  while (count > 0 && to < chars.length - 1 && !chars[to].lineBreakAfter && isPunctuation(chars[to + 1])) {
    to += 1;
    count -= 1;
  }
  return to;
}

/** Same line-by-line rects the reader builds for a text selection. */
function rangeRects(chars: PdfChar[], from: number, to: number): number[][] {
  const rects: number[][] = [];
  const norm = (r: number[]) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  let start = from;
  for (let i = from; i <= to; i++) {
    const char = chars[i];
    if (!char) break;
    if (!char.lineBreakAfter && i !== to) continue;
    const firstChar = chars[start];
    const firstRect = norm(firstChar.rect);
    const lastRect = norm(char.rect);
    const inline = norm(firstChar.inlineRect ?? firstChar.rect);
    const vertical = firstChar.rotation === 90 || firstChar.rotation === 270;
    const rect = vertical
      ? [inline[0], firstRect[1], inline[2], lastRect[3]]
      : [firstRect[0], inline[1], lastRect[2], inline[3]];
    rects.push(rect.map(round));
    start = i + 1;
  }
  return rects;
}

function textFromChars(chars: PdfChar[]): string {
  const parts: string[] = [];
  for (const char of chars) {
    if (char.ignorable) continue;
    parts.push(char.c);
    if (char.spaceAfter || char.lineBreakAfter) parts.push(" ");
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
