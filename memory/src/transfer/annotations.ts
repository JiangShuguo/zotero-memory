/** Export / import PDF annotations for a Memory backup file. */
import { logError } from "../settings";
import { readPdfText } from "./pdf-text";
import {
  indexDocument,
  locatePoint,
  locateText,
  pageText,
  placeText,
  pointAnchorAt,
  sortIndex,
  textAnchorAt,
  topLeft,
  type DocIndex,
  type LocateHint,
  type PointAnchor,
  type TextAnchor,
} from "./relocate";

export const BACKUP_FORMAT = "zotero-memory-annotations";
export const BACKUP_VERSION = 2;
const READABLE_VERSIONS = new Set([1, 2]);
const TEXT_TYPES = new Set(["highlight", "underline"]);

export interface AnnotationBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  pdf: {
    md5: string;
    filename: string;
    title?: string;
    pageCount?: number;
  };
  annotations: AnnotationPayload[];
}

export interface AnnotationPayload {
  type: string;
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  sortIndex: string;
  position: Record<string, any>;
  tags?: Array<{ name: string }>;
  image?: string;
  anchor?: TextAnchor & Partial<PointAnchor>;
}

export interface ProblemEntry {
  type: string;
  pageLabel: string;
  snippet: string;
  reason: string;
}

export interface ImportPlan {
  exact: boolean;
  items: Array<{ payload: AnnotationPayload; moved: boolean }>;
  duplicates: number;
  approximate: ProblemEntry[];
  failed: ProblemEntry[];
}

export interface ImportResult {
  created: number;
}

function parentTitle(attachment: any): string | undefined {
  try {
    const parent = attachment.parentItem ?? (attachment.parentID ? (Zotero as any).Items.get(attachment.parentID) : undefined);
    const title = String(parent?.getField?.("title") ?? "").trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

export async function pdfMd5(attachment: any): Promise<string> {
  const path = await attachment.getFilePathAsync?.();
  if (!path) throw new Error("找不到该 PDF 文件。");
  const hash = await (Zotero as any).Utilities.Internal.md5Async(path);
  if (!hash) throw new Error("无法计算 PDF 校验值。");
  return String(hash);
}

export async function buildBackup(attachment: any): Promise<AnnotationBackup> {
  if (!attachment?.isPDFAttachment?.()) throw new Error("目标不是 PDF 附件。");
  const md5 = await pdfMd5(attachment);
  const annotations: AnnotationPayload[] = [];
  for (const item of attachment.getAnnotations?.(false) ?? []) {
    if (!item?.isAnnotation?.()) continue;
    const json = await (Zotero as any).Annotations.toJSON(item);
    annotations.push(payloadFromJson(json));
  }

  let pageCount: number | undefined;
  if (annotations.length) {
    try {
      const index = indexDocument(await readPdfText(attachment));
      pageCount = index.doc.pageCount;
      for (const payload of annotations) payload.anchor = anchorFor(index, payload);
    } catch (error) {
      // Anchors only help when importing into a different file; the backup is still valid.
      logError(error);
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    pdf: {
      md5,
      filename: String(attachment.attachmentFilename || attachment.getField?.("title") || "document.pdf"),
      title: parentTitle(attachment),
      pageCount,
    },
    annotations,
  };
}

export function parseBackup(raw: string): AnnotationBackup {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("无法解析 Memory 标注备份文件。");
  }
  if (!data || data.format !== BACKUP_FORMAT || !READABLE_VERSIONS.has(data.version)) {
    throw new Error("文件不是有效的 Memory 标注备份。");
  }
  if (!data.pdf?.md5 || !Array.isArray(data.annotations)) {
    throw new Error("Memory 标注备份内容不完整。");
  }
  return data as AnnotationBackup;
}

/**
 * Works out where every annotation goes without writing anything.
 * Identical files restore as-is; otherwise each annotation is found again by its text.
 */
export async function planImport(attachment: any, backup: AnnotationBackup): Promise<ImportPlan> {
  if (!attachment?.isPDFAttachment?.()) throw new Error("目标不是 PDF 附件。");
  const exact = (await pdfMd5(attachment)) === backup.pdf.md5;
  const plan: ImportPlan = { exact, items: [], duplicates: 0, approximate: [], failed: [] };
  const existing = existingFingerprints(attachment);
  const index = exact ? undefined : indexDocument(await readPdfText(attachment));

  for (const payload of backup.annotations) {
    if (!payload?.type || !payload.sortIndex || !payload.position) {
      plan.failed.push(problem(payload, "备份条目不完整"));
      continue;
    }
    let placed: AnnotationPayload | undefined = payload;
    let moved = false;
    if (index) {
      const outcome = relocate(index, payload, backup.pdf.pageCount);
      if ("reason" in outcome) {
        plan.failed.push(problem(payload, outcome.reason));
        continue;
      }
      placed = outcome.payload;
      moved = true;
      if (outcome.approximate) plan.approximate.push(problem(payload, "按原坐标放置，请核对位置"));
    }
    const key = fingerprint(placed);
    if (existing.has(key)) {
      plan.duplicates += 1;
      continue;
    }
    existing.add(key);
    plan.items.push({ payload: placed, moved });
  }
  return plan;
}

export async function applyImport(attachment: any, plan: ImportPlan): Promise<ImportResult> {
  let created = 0;
  for (const { payload, moved } of plan.items) {
    const item = await (Zotero as any).Annotations.saveFromJSON(attachment, {
      key: (Zotero as any).DataObjectUtilities.generateKey(),
      type: payload.type,
      text: payload.text,
      comment: payload.comment ?? "",
      color: payload.color,
      pageLabel: payload.pageLabel ?? "",
      sortIndex: payload.sortIndex,
      position: payload.position,
      tags: payload.tags,
      isExternal: false,
    });
    // A moved image annotation shows a different region; Zotero re-renders it when missing.
    if (!moved && payload.image && ["image", "ink"].includes(payload.type)) {
      try {
        const blob = await dataURIToBlob(payload.image);
        if (blob) await (Zotero as any).Annotations.saveCacheImage(item, blob);
      } catch {
        // Geometry still restores; cache image is best-effort.
      }
    }
    created += 1;
  }
  return { created };
}

// ---------------------------------------------------------------------------

function anchorFor(index: DocIndex, payload: AnnotationPayload): AnnotationPayload["anchor"] {
  const pageIndex = Number(payload.position?.pageIndex ?? 0);
  const rects: number[][] = Array.isArray(payload.position?.rects) ? payload.position.rects : [];
  if (TEXT_TYPES.has(payload.type) && payload.text) {
    return textAnchorAt(index, payload.text, pageIndex, rects);
  }
  const point = referencePoint(payload.position);
  return point ? pointAnchorAt(index, pageIndex, point) : undefined;
}

type Relocation = { payload: AnnotationPayload; approximate: boolean } | { reason: string };

function relocate(index: DocIndex, payload: AnnotationPayload, sourcePageCount?: number): Relocation {
  const pageIndex = Number(payload.position?.pageIndex ?? 0);
  const hint: LocateHint = {
    pageIndex,
    sourcePageCount,
    prefix: payload.anchor?.prefix,
    suffix: payload.anchor?.suffix,
    top: topOf(index, payload.position),
  };

  if (TEXT_TYPES.has(payload.type) && payload.text?.trim()) {
    const match = locateText(index, payload.text, hint);
    if (!match) return { reason: "目标 PDF 中未找到对应文本" };
    const placement = placeText(index, match, payload.text);
    if (!placement) return { reason: "对应文本在目标 PDF 中跨越多页" };
    const position: Record<string, any> = { ...payload.position, ...placement.position };
    if (!placement.position.nextPageRects) delete position.nextPageRects;
    return {
      approximate: false,
      payload: {
        ...payload,
        text: placement.text,
        pageLabel: placement.pageLabel,
        sortIndex: placement.sortIndex,
        position,
      },
    };
  }

  const original = referencePoint(payload.position);
  if (!original) return { reason: "无法读取批注位置" };
  const anchor = payload.anchor;
  if (anchor?.context) {
    const found = locatePoint(index, anchor as PointAnchor, { ...hint, prefix: undefined, suffix: undefined });
    if (!found) return { reason: "目标 PDF 中未找到批注邻近文本" };
    return { approximate: false, payload: moveTo(index, payload, found.pageIndex, original, found.point, found.charIndex) };
  }
  if (pageIndex >= index.doc.pageCount) return { reason: `目标 PDF 缺少第 ${pageIndex + 1} 页` };
  return { approximate: true, payload: moveTo(index, payload, pageIndex, original, original, 0) };
}

function moveTo(
  index: DocIndex,
  payload: AnnotationPayload,
  pageIndex: number,
  from: [number, number],
  to: [number, number],
  charIndex: number,
): AnnotationPayload {
  const page = pageText(index, pageIndex);
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  const box = boundingBox(payload.position);
  if (page && box) {
    const [vx1, vy1, vx2, vy2] = page.viewBox;
    if (box[2] + dx > vx2) dx = vx2 - box[2];
    if (box[0] + dx < vx1) dx = vx1 - box[0];
    if (box[3] + dy > vy2) dy = vy2 - box[3];
    if (box[1] + dy < vy1) dy = vy1 - box[1];
  }
  const shift = (rect: number[]) => [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy].map(round);
  const position: Record<string, any> = { ...payload.position, pageIndex };
  if (Array.isArray(position.rects)) position.rects = position.rects.map(shift);
  if (Array.isArray(position.paths)) {
    position.paths = position.paths.map((path: number[]) => path.map((value, i) => round(value + (i % 2 ? dy : dx))));
  }
  delete position.nextPageRects;
  const rects: number[][] = position.rects ?? (box ? [shift(box)] : []);
  return {
    ...payload,
    position,
    pageLabel: page?.label ?? payload.pageLabel,
    sortIndex: page && rects.length ? sortIndex(page, charIndex, rects) : payload.sortIndex,
  };
}

function referencePoint(position: Record<string, any> | undefined): [number, number] | undefined {
  const box = boundingBox(position);
  return box ? topLeft([box]) : undefined;
}

function boundingBox(position: Record<string, any> | undefined): number[] | undefined {
  const rects: number[][] = [];
  if (Array.isArray(position?.rects)) rects.push(...position!.rects);
  if (Array.isArray(position?.paths)) {
    for (const path of position!.paths as number[][]) {
      for (let i = 0; i + 1 < path.length; i += 2) rects.push([path[i], path[i + 1], path[i], path[i + 1]]);
    }
  }
  const valid = rects.filter((rect) => Array.isArray(rect) && rect.length >= 4 && rect.every(Number.isFinite));
  if (!valid.length) return undefined;
  return [
    Math.min(...valid.map((r) => Math.min(r[0], r[2]))),
    Math.min(...valid.map((r) => Math.min(r[1], r[3]))),
    Math.max(...valid.map((r) => Math.max(r[0], r[2]))),
    Math.max(...valid.map((r) => Math.max(r[1], r[3]))),
  ];
}

function topOf(index: DocIndex, position: Record<string, any>): number | undefined {
  const box = boundingBox(position);
  const page = pageText(index, Number(position?.pageIndex ?? 0));
  if (!box || !page) return undefined;
  const height = page.viewBox[3] - page.viewBox[1];
  return height > 0 ? Math.min(1, Math.max(0, (page.viewBox[3] - box[3]) / height)) : undefined;
}

function existingFingerprints(attachment: any): Set<string> {
  const existing = new Set<string>();
  for (const item of attachment.getAnnotations?.(false) ?? []) {
    if (!item?.isAnnotation?.()) continue;
    existing.add(fingerprint((Zotero as any).Annotations.toJSONSync(item)));
  }
  return existing;
}

const TYPE_LABELS: Record<string, string> = {
  highlight: "高亮",
  underline: "下划线",
  note: "便签",
  text: "文本",
  image: "图片",
  ink: "手绘",
};

function problem(payload: AnnotationPayload | undefined, reason: string): ProblemEntry {
  const source = String(payload?.text || payload?.comment || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return {
    type: TYPE_LABELS[String(payload?.type)] ?? String(payload?.type ?? "批注"),
    pageLabel: String(payload?.pageLabel || Number(payload?.position?.pageIndex ?? 0) + 1),
    snippet: source.length > 40 ? `${source.slice(0, 40)}…` : source,
    reason,
  };
}

function payloadFromJson(json: any): AnnotationPayload {
  const payload: AnnotationPayload = {
    type: String(json.type),
    comment: String(json.comment ?? ""),
    color: typeof json.color === "string" ? json.color : undefined,
    pageLabel: String(json.pageLabel ?? ""),
    sortIndex: String(json.sortIndex ?? ""),
    position: json.position && typeof json.position === "object" ? { ...json.position } : { pageIndex: 0 },
  };
  if (typeof json.text === "string") payload.text = json.text;
  if (Array.isArray(json.tags) && json.tags.length) {
    payload.tags = json.tags
      .map((tag: any) => ({ name: String(tag.name ?? tag.tag ?? "") }))
      .filter((tag: { name: string }) => tag.name);
  }
  if (typeof json.image === "string" && json.image.startsWith("data:")) payload.image = json.image;
  return payload;
}

function fingerprint(value: { type?: string; text?: string; color?: string; position?: unknown }): string {
  return [
    String(value.type ?? ""),
    String(value.color ?? ""),
    String(value.text ?? ""),
    JSON.stringify(value.position ?? null),
  ].join("\u001f");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function dataURIToBlob(dataURI: string): Promise<Blob | undefined> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataURI);
  if (!match) return undefined;
  const mime = match[1] || "application/octet-stream";
  const data = match[3] ?? "";
  if (match[2]) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(data)], { type: mime });
}
