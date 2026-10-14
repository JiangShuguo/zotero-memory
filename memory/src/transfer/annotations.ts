/** Export / import PDF annotations for a Memory backup file. */

export const BACKUP_FORMAT = "zotero-memory-annotations";
export const BACKUP_VERSION = 1;

export interface AnnotationBackup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  pdf: {
    md5: string;
    filename: string;
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
  position: Record<string, unknown>;
  tags?: Array<{ name: string }>;
  image?: string;
}

export interface ImportResult {
  created: number;
  skipped: number;
}

export async function pdfMd5(attachment: any): Promise<string> {
  const path = await attachment.getFilePathAsync?.();
  if (!path) throw new Error("找不到该 PDF 文件。");
  const hash = await (Zotero as any).Utilities.Internal.md5Async(path);
  if (!hash) throw new Error("无法计算该 PDF 的校验值。");
  return String(hash);
}

export async function buildBackup(attachment: any): Promise<AnnotationBackup> {
  if (!attachment?.isPDFAttachment?.()) throw new Error("请先选中一个 PDF 附件。");
  const md5 = await pdfMd5(attachment);
  const annotations: AnnotationPayload[] = [];
  for (const item of attachment.getAnnotations?.(false) ?? []) {
    if (!item?.isAnnotation?.()) continue;
    const json = await (Zotero as any).Annotations.toJSON(item);
    annotations.push(payloadFromJson(json));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    pdf: {
      md5,
      filename: String(attachment.attachmentFilename || attachment.getField?.("title") || "document.pdf"),
    },
    annotations,
  };
}

export function parseBackup(raw: string): AnnotationBackup {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("这不是有效的 Memory 标注备份文件。");
  }
  if (!data || data.format !== BACKUP_FORMAT || data.version !== BACKUP_VERSION) {
    throw new Error("这不是 Memory 标注备份。");
  }
  if (!data.pdf?.md5 || !Array.isArray(data.annotations)) {
    throw new Error("这份 Memory 标注备份不完整。");
  }
  return data as AnnotationBackup;
}

/**
 * Restores every annotation from the backup onto `attachment` when the PDF
 * bytes match. Existing annotations with the same fingerprint are left alone.
 */
export async function importBackup(attachment: any, backup: AnnotationBackup): Promise<ImportResult> {
  if (!attachment?.isPDFAttachment?.()) throw new Error("请先选中一个 PDF 附件。");
  const md5 = await pdfMd5(attachment);
  if (md5 !== backup.pdf.md5) {
    throw new Error("两份 PDF 不完全一致，无法导入。只有文件内容完全相同时才能还原标注。");
  }

  const existing = new Set<string>();
  for (const item of attachment.getAnnotations?.(false) ?? []) {
    if (!item?.isAnnotation?.()) continue;
    const json = (Zotero as any).Annotations.toJSONSync(item);
    existing.add(fingerprint(json));
  }

  let created = 0;
  let skipped = 0;
  for (const payload of backup.annotations) {
    if (!payload?.type || !payload.sortIndex || !payload.position) {
      skipped += 1;
      continue;
    }
    if (existing.has(fingerprint(payload))) {
      skipped += 1;
      continue;
    }
    const key = (Zotero as any).DataObjectUtilities.generateKey();
    const item = await (Zotero as any).Annotations.saveFromJSON(attachment, {
      key,
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
    if (payload.image && ["image", "ink"].includes(payload.type)) {
      try {
        const blob = await dataURIToBlob(payload.image);
        if (blob) await (Zotero as any).Annotations.saveCacheImage(item, blob);
      } catch {
        // Geometry still restores; cache image is best-effort.
      }
    }
    existing.add(fingerprint(payload));
    created += 1;
  }
  return { created, skipped };
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
