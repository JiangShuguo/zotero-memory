export const ANNOTATION_TYPES = [
  "highlight",
  "underline",
  "note",
  "text",
  "image",
] as const;

export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type MarginSide = "left" | "right";

export interface PdfPointBox {
  pageIndex: number;
  rects?: number[][];
  nextPageRects?: number[][];
  paths?: number[][];
  width?: number;
}

export interface MarginNote {
  itemID: number;
  key: string;
  type: AnnotationType;
  comment: string;
  color: string;
  pageLabel: string;
  position: PdfPointBox;
  readOnly: boolean;
}

export interface PageAnchor {
  x: number;
  y: number;
  side: MarginSide;
}

export interface ViewportBox {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
}
