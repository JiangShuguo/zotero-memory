import {
  ANNOTATION_TYPES,
  type AnnotationType,
  type MarginNote,
  type PageAnchor,
  type PdfPointBox,
  type ViewportBox,
} from "./types";

const KNOWN_TYPES = new Set<string>(ANNOTATION_TYPES);

export function isAnnotationType(value: unknown): value is AnnotationType {
  return typeof value === "string" && KNOWN_TYPES.has(value);
}

export function readPosition(value: unknown): PdfPointBox | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Partial<PdfPointBox>;
  if (!Number.isInteger(record.pageIndex) || Number(record.pageIndex) < 0) return undefined;
  return {
    pageIndex: Number(record.pageIndex),
    rects: copyNumberLists(record.rects),
    nextPageRects: copyNumberLists(record.nextPageRects),
    paths: copyNumberLists(record.paths),
    width: typeof record.width === "number" ? record.width : undefined,
  };
}

export function noteShouldShow(note: MarginNote, pinned: ReadonlySet<string> = new Set()): boolean {
  return pinned.has(note.key) || note.type === "note" || note.comment.trim().length > 0;
}

export function anchorOnPage(position: PdfPointBox, viewport: ViewportBox): PageAnchor | undefined {
  const rects = (position.rects ?? []).filter((rect) => rect.length >= 4);
  if (rects.length) {
    const boxes = rects.map((rect) => pdfRectToViewport(rect, viewport));
    return sideAnchor(boundsOf(boxes), viewport);
  }

  const points = (position.paths ?? [])
    .flatMap(pairs)
    .map(([x, y]) => viewport.convertToViewportPoint(x, y));
  if (!points.length) return undefined;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return sideAnchor(
    {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    },
    viewport,
  );
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function pdfRectToViewport(rect: number[], viewport: ViewportBox): Bounds {
  const [x1, y2] = viewport.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y1] = viewport.convertToViewportPoint(rect[2], rect[3]);
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  };
}

function boundsOf(boxes: Bounds[]): Bounds {
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    right: Math.max(...boxes.map((box) => box.right)),
    top: Math.min(...boxes.map((box) => box.top)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function sideAnchor(bounds: Bounds, viewport: ViewportBox): PageAnchor {
  const side = (bounds.left + bounds.right) / 2 < viewport.width / 2 ? "left" : "right";
  return {
    x: clamp(side === "left" ? bounds.left : bounds.right, 0, viewport.width),
    y: clamp(bounds.top, 0, viewport.height),
    side,
  };
}

function copyNumberLists(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lists = value.filter(
    (entry): entry is number[] =>
      Array.isArray(entry) && entry.length > 0 && entry.every((item) => Number.isFinite(item)),
  );
  return lists.length ? lists.map((entry) => entry.slice()) : undefined;
}

function pairs(values: number[]): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    result.push([values[index]!, values[index + 1]!]);
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
