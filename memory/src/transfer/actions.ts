import { logError } from "../settings";
import {
  applyImport,
  buildBackup,
  parseBackup,
  planImport,
  type AnnotationBackup,
  type ImportPlan,
  type ProblemEntry,
} from "./annotations";
import { chooseJsonFilesForImport, choosePdfsForExport, type ImportMatchRow } from "./batch-ui";
import {
  alertUser,
  chooseBackupFolder,
  chooseBackupOpenPath,
  chooseBackupSavePath,
  confirmUser,
  showProgress,
} from "./dialogs";

const MAX_LISTED_PROBLEMS = 15;

const ITEM_MENU_IDS = {
  separator: "mem-itemmenu-separator",
  export: "mem-itemmenu-export",
  import: "mem-itemmenu-import",
} as const;

export async function exportAnnotations(): Promise<void> {
  try {
    const attachment = resolvePdfAttachment();
    if (!attachment) {
      alertUser("Memory", "请先选中一个 PDF 附件，或打开该 PDF。");
      return;
    }
    const done = showProgress("正在读取批注与 PDF 文本…");
    let backup;
    try {
      backup = await buildBackup(attachment);
    } finally {
      done();
    }
    const stem = String(attachment.attachmentFilename || "annotations").replace(/\.pdf$/i, "");
    const path = await chooseBackupSavePath(`${stem}-memory-annotations.json`);
    if (!path) return;
    await (Zotero as any).File.putContentsAsync(path, JSON.stringify(backup, null, 2));
    alertUser("Memory", `已导出 ${backup.annotations.length} 条批注。`);
  } catch (error) {
    logError(error);
    alertUser("Memory", errorMessage(error));
  }
}

/** `onImported` runs after new annotations are saved, before the summary is shown. */
export async function importAnnotations(onImported: () => void): Promise<void> {
  try {
    const attachment = resolvePdfAttachment();
    if (!attachment) {
      alertUser("Memory", "请先选中要还原到的 PDF 附件，或打开该 PDF。");
      return;
    }
    const path = await chooseBackupOpenPath();
    if (!path) return;
    const raw = await (Zotero as any).File.getContentsAsync(path);
    const backup = parseBackup(String(raw));
    const done = showProgress("正在比对 PDF 文本…");
    let plan: ImportPlan;
    try {
      plan = await planImport(attachment, backup);
    } finally {
      done();
    }
    if (!plan.items.length) {
      alertUser("Memory", nothingToImport(plan));
      return;
    }
    if ((!plan.exact || plan.failed.length) && !confirmUser("Memory", planSummary(plan))) return;
    const result = await applyImport(attachment, plan);
    try {
      onImported();
    } catch (error) {
      logError(error);
    }
    alertUser("Memory", resultSummary(plan, result.created));
  } catch (error) {
    logError(error);
    alertUser("Memory", errorMessage(error));
  }
}

/** Opens a collection-folded PDF picker, then writes backups into a chosen folder. */
export async function batchExportAnnotations(): Promise<void> {
  try {
    const ids = await choosePdfsForExport();
    if (ids === undefined) return;
    if (!ids.length) {
      alertUser("Memory", "文库中没有可导出的 PDF。");
      return;
    }
    const attachments = ids
      .map((id) => (Zotero as any).Items.get(id))
      .filter((item: any) => item?.isPDFAttachment?.());
    if (!attachments.length) {
      alertUser("Memory", "所选条目中没有有效的 PDF 附件。");
      return;
    }
    const folder = await chooseBackupFolder("选择导出目录");
    if (!folder) return;
    const done = showProgress(`正在导出 ${attachments.length} 个 PDF…`);
    let exported = 0;
    const failures: string[] = [];
    try {
      for (const attachment of attachments) {
        const label = displayName(attachment);
        try {
          const backup = await buildBackup(attachment);
          const stem = sanitizeFilename(String(attachment.attachmentFilename || label).replace(/\.pdf$/i, ""));
          const path = joinPath(folder, `${stem}-memory-annotations.json`);
          await (Zotero as any).File.putContentsAsync(path, JSON.stringify(backup, null, 2));
          exported += 1;
        } catch (error) {
          logError(error);
          failures.push(`• ${label}：${errorMessage(error)}`);
        }
      }
    } finally {
      done();
    }
    const lines = [`已导出 ${exported} 个备份文件。`];
    if (failures.length) lines.push("", `以下 ${failures.length} 项失败：`, ...failures.slice(0, MAX_LISTED_PROBLEMS));
    if (failures.length > MAX_LISTED_PROBLEMS) lines.push(`…另有 ${failures.length - MAX_LISTED_PROBLEMS} 项`);
    alertUser("Memory", lines.join("\n"));
  } catch (error) {
    logError(error);
    alertUser("Memory", errorMessage(error));
  }
}

/**
 * Opens a multi-file import dialog; matches each backup to a library PDF by
 * filename or parent item title, then imports the matched set.
 */
export async function batchImportAnnotations(onImported: () => void): Promise<void> {
  try {
    const preferred = new Set(resolveSelectedPdfAttachments().map((item) => item.id));
    const catalog = await buildPdfCatalog();
    const previewCache = new Map<string, { backup?: AnnotationBackup; match?: { attachment: any; ambiguous: boolean }; error?: string }>();

    const files = await chooseJsonFilesForImport(async (paths) => {
      const rows: ImportMatchRow[] = [];
      for (const path of paths) {
        const fileName = basename(path);
        try {
          const raw = await (Zotero as any).File.getContentsAsync(path);
          const backup = parseBackup(String(raw));
          const match = matchAttachment(backup, catalog, preferred);
          previewCache.set(path, { backup, match });
          if (!match) {
            rows.push({ path, fileName, status: "unmatched", message: "未找到匹配的 PDF（文件名或题名）" });
            continue;
          }
          rows.push({
            path,
            fileName,
            status: "matched",
            targetLabel: displayName(match.attachment) + (match.ambiguous ? "（多个匹配，已选用其一）" : ""),
          });
        } catch (error) {
          logError(error);
          const message = errorMessage(error);
          previewCache.set(path, { error: message });
          rows.push({ path, fileName, status: "error", message });
        }
      }
      return rows;
    });
    if (files === undefined) return;
    if (!files.length) {
      alertUser("Memory", "没有可导入的匹配项。");
      return;
    }

    const unmatched: string[] = [];
    const ambiguous: string[] = [];
    const planned: Array<{ label: string; attachment: any; plan: ImportPlan }> = [];
    const fileFailures: string[] = [];

    const close = showProgress(`正在准备导入 ${files.length} 个备份…`);
    try {
      for (const path of files) {
        const fileLabel = basename(path);
        try {
          let cached = previewCache.get(path);
          if (!cached?.backup) {
            const raw = await (Zotero as any).File.getContentsAsync(path);
            const backup = parseBackup(String(raw));
            cached = { backup, match: matchAttachment(backup, catalog, preferred) };
          }
          const backup = cached.backup!;
          const match = cached.match ?? matchAttachment(backup, catalog, preferred);
          if (!match) {
            unmatched.push(`• ${fileLabel}：未找到匹配的 PDF（文件名或题名）`);
            continue;
          }
          if (match.ambiguous) {
            ambiguous.push(`• ${fileLabel} → ${displayName(match.attachment)}：存在多个匹配，已选用其一`);
          }
          const plan = await planImport(match.attachment, backup);
          if (!plan.items.length && !plan.failed.length && !plan.duplicates) {
            fileFailures.push(`• ${fileLabel}：备份中没有批注`);
            continue;
          }
          planned.push({ label: `${fileLabel} → ${displayName(match.attachment)}`, attachment: match.attachment, plan });
        } catch (error) {
          logError(error);
          fileFailures.push(`• ${fileLabel}：${errorMessage(error)}`);
        }
      }
    } finally {
      close();
    }

    if (!planned.length) {
      alertUser("Memory", batchNothingSummary(unmatched, ambiguous, fileFailures));
      return;
    }

    const needsConfirm =
      unmatched.length > 0 ||
      ambiguous.length > 0 ||
      fileFailures.length > 0 ||
      planned.some((entry) => !entry.plan.exact || entry.plan.failed.length || entry.plan.approximate.length);
    if (needsConfirm && !confirmUser("Memory", batchPlanSummary(planned, unmatched, ambiguous, fileFailures))) return;

    let created = 0;
    const applyClose = showProgress(`正在导入 ${planned.length} 个 PDF…`);
    try {
      for (const entry of planned) {
        if (entry.plan.items.length) {
          const result = await applyImport(entry.attachment, entry.plan);
          created += result.created;
        }
      }
    } finally {
      applyClose();
    }
    try {
      onImported();
    } catch (error) {
      logError(error);
    }
    alertUser("Memory", batchResultSummary(planned, created, unmatched, ambiguous, fileFailures));
  } catch (error) {
    logError(error);
    alertUser("Memory", errorMessage(error));
  }
}

/** Adds export/import entries to the item context menu of a main window. Returns the undo. */
export function addItemMenu(win: Window, actions: { export(): void; import(): void }): (() => void) | undefined {
  const doc = win.document;
  const menu = doc.getElementById("zotero-itemmenu");
  if (!menu || menu.getAttribute("data-mem-bound") === "true") return undefined;
  menu.setAttribute("data-mem-bound", "true");

  const separator = createXul(doc, "menuseparator");
  separator.id = ITEM_MENU_IDS.separator;
  const exportItem = createXul(doc, "menuitem");
  exportItem.id = ITEM_MENU_IDS.export;
  exportItem.setAttribute("label", "导出标注备份");
  const importItem = createXul(doc, "menuitem");
  importItem.id = ITEM_MENU_IDS.import;
  importItem.setAttribute("label", "导入标注备份");

  const onExport = () => actions.export();
  const onImport = () => actions.import();
  const onShowing = () => {
    const enabled = Boolean(resolvePdfAttachment());
    exportItem.setAttribute("disabled", enabled ? "false" : "true");
    importItem.setAttribute("disabled", enabled ? "false" : "true");
  };

  exportItem.addEventListener("command", onExport);
  importItem.addEventListener("command", onImport);
  menu.addEventListener("popupshowing", onShowing);
  menu.append(separator, exportItem, importItem);

  return () => {
    menu.removeEventListener("popupshowing", onShowing);
    exportItem.removeEventListener("command", onExport);
    importItem.removeEventListener("command", onImport);
    separator.remove();
    exportItem.remove();
    importItem.remove();
    menu.removeAttribute("data-mem-bound");
  };
}

function createXul(doc: Document, name: string): XULElement {
  const create = (doc as any).createXULElement?.bind(doc) as ((tag: string) => XULElement) | undefined;
  if (create) return create(name);
  return doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", name) as XULElement;
}

/** The selected PDF in the library, or else the PDF open in a reader tab. */
function resolvePdfAttachment(): any | undefined {
  return resolveSelectedPdfAttachments()[0] ?? resolveOpenReaderPdf();
}

function resolveOpenReaderPdf(): any | undefined {
  for (const reader of (Zotero as any).Reader?._readers ?? []) {
    if (reader?._type !== "pdf" && reader?.type !== "pdf") continue;
    const pdf = asPdfAttachment((Zotero as any).Items?.get?.(reader.itemID));
    if (pdf) return pdf;
  }
  return undefined;
}

function resolveSelectedPdfAttachments(): any[] {
  const pane = (Zotero as any).getActiveZoteroPane?.();
  const seen = new Set<number>();
  const out: any[] = [];
  for (const item of pane?.getSelectedItems?.() ?? []) {
    for (const pdf of collectPdfAttachments(item)) {
      if (seen.has(pdf.id)) continue;
      seen.add(pdf.id);
      out.push(pdf);
    }
  }
  return out;
}

function collectPdfAttachments(item: any): any[] {
  const pdf = asPdfAttachment(item);
  if (!pdf) return [];
  if (pdf === item || item?.isPDFAttachment?.()) return [pdf];
  // Parent item: include every PDF child, not only the first.
  if (item?.isRegularItem?.()) {
    const ids: number[] = item.getAttachments?.() ?? [];
    const children: any[] = [];
    for (const id of ids) {
      const child = (Zotero as any).Items.get(id);
      if (child?.isPDFAttachment?.()) children.push(child);
    }
    return children;
  }
  return [pdf];
}

function asPdfAttachment(item: any): any | undefined {
  if (!item) return undefined;
  if (item.isPDFAttachment?.()) return item;
  if (item.isAttachment?.() && String(item.attachmentContentType || "").includes("pdf")) return item;
  if (!item.isRegularItem?.()) return undefined;
  const ids: number[] = item.getAttachments?.() ?? [];
  for (const id of ids) {
    const child = (Zotero as any).Items.get(id);
    if (child?.isPDFAttachment?.()) return child;
  }
  return undefined;
}

interface PdfCatalogEntry {
  attachment: any;
  filenameKey: string;
  titleKey: string;
}

async function buildPdfCatalog(): Promise<PdfCatalogEntry[]> {
  const entries: PdfCatalogEntry[] = [];
  for (const library of (Zotero as any).Libraries?.getAll?.() ?? []) {
    let items: any[] = [];
    try {
      items = (await (Zotero as any).Items.getAll(library.libraryID)) ?? [];
    } catch (error) {
      logError(error);
      continue;
    }
    for (const item of items) {
      if (!item?.isPDFAttachment?.()) continue;
      entries.push({
        attachment: item,
        filenameKey: normalizeName(String(item.attachmentFilename || "")),
        titleKey: normalizeName(parentTitleOf(item) || ""),
      });
    }
  }
  return entries;
}

function matchAttachment(
  backup: AnnotationBackup,
  catalog: PdfCatalogEntry[],
  preferred: Set<number>,
): { attachment: any; ambiguous: boolean } | undefined {
  const filenameKey = normalizeName(backup.pdf.filename);
  const titleKey = normalizeName(backup.pdf.title || "");
  let hits = filenameKey ? catalog.filter((entry) => entry.filenameKey === filenameKey) : [];
  if (!hits.length && titleKey) hits = catalog.filter((entry) => entry.titleKey === titleKey);
  if (!hits.length) return undefined;
  const preferredHits = hits.filter((entry) => preferred.has(entry.attachment.id));
  const pool = preferredHits.length ? preferredHits : hits;
  return { attachment: pool[0].attachment, ambiguous: hits.length > 1 };
}

function parentTitleOf(attachment: any): string | undefined {
  try {
    const parent = attachment.parentItem ?? (attachment.parentID ? (Zotero as any).Items.get(attachment.parentID) : undefined);
    const title = String(parent?.getField?.("title") ?? "").trim();
    return title || undefined;
  } catch {
    return undefined;
  }
}

function normalizeName(value: string): string {
  return value
    .replace(/\.pdf$/i, "")
    .replace(/-memory-annotations$/i, "")
    .trim()
    .toLowerCase();
}

function displayName(attachment: any): string {
  return String(attachment.attachmentFilename || parentTitleOf(attachment) || attachment.id || "PDF");
}

function sanitizeFilename(stem: string): string {
  const cleaned = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "annotations";
  return cleaned.slice(0, 120);
}

function joinPath(folder: string, name: string): string {
  const PathUtils = (globalThis as any).PathUtils;
  if (PathUtils?.join) return PathUtils.join(folder, name);
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function basename(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

function planSummary(plan: ImportPlan): string {
  const lines = [
    plan.exact
      ? `可还原 ${plan.items.length} 条批注。`
      : `目标 PDF 与备份文件不一致，已按文本重新定位：可还原 ${plan.items.length} 条批注。`,
  ];
  if (plan.duplicates) lines.push(`${plan.duplicates} 条已存在，将跳过。`);
  if (plan.approximate.length) {
    lines.push("", `以下 ${plan.approximate.length} 条无法按文本核对，将按原坐标放置：`, ...listProblems(plan.approximate));
  }
  if (plan.failed.length) {
    lines.push("", `以下 ${plan.failed.length} 条无法导入：`, ...listProblems(plan.failed));
  }
  lines.push("", "是否继续导入？");
  return lines.join("\n");
}

function resultSummary(plan: ImportPlan, created: number): string {
  const lines = [`已导入 ${created} 条批注。`];
  if (plan.duplicates) lines.push(`跳过 ${plan.duplicates} 条已存在的批注。`);
  if (plan.approximate.length) lines.push(`${plan.approximate.length} 条按原坐标放置，请打开 PDF 核对。`);
  if (plan.failed.length) lines.push(`${plan.failed.length} 条未能导入。`);
  return lines.join("\n");
}

function nothingToImport(plan: ImportPlan): string {
  if (!plan.failed.length) {
    return plan.duplicates ? `备份中的 ${plan.duplicates} 条批注均已存在，无需导入。` : "备份中没有批注。";
  }
  const lines = [`没有可导入的批注，${plan.failed.length} 条无法导入：`, ...listProblems(plan.failed)];
  if (plan.duplicates) lines.push("", `另有 ${plan.duplicates} 条已存在。`);
  return lines.join("\n");
}

function batchPlanSummary(
  planned: Array<{ label: string; plan: ImportPlan }>,
  unmatched: string[],
  ambiguous: string[],
  fileFailures: string[],
): string {
  const placeable = planned.reduce((sum, entry) => sum + entry.plan.items.length, 0);
  const lines = [`已匹配 ${planned.length} 个备份，可导入 ${placeable} 条批注。`];
  for (const entry of planned) {
    if (!entry.plan.failed.length && !entry.plan.approximate.length && entry.plan.exact) continue;
    lines.push("", entry.label);
    if (!entry.plan.exact) lines.push("  目标文件与备份不一致，已按文本重新定位。");
    if (entry.plan.approximate.length) {
      lines.push(`  按原坐标放置 ${entry.plan.approximate.length} 条：`, ...listProblems(entry.plan.approximate, "  "));
    }
    if (entry.plan.failed.length) {
      lines.push(`  无法导入 ${entry.plan.failed.length} 条：`, ...listProblems(entry.plan.failed, "  "));
    }
  }
  if (unmatched.length) lines.push("", `未匹配 ${unmatched.length} 个文件：`, ...unmatched.slice(0, MAX_LISTED_PROBLEMS));
  if (ambiguous.length) lines.push("", `多义匹配 ${ambiguous.length} 项：`, ...ambiguous.slice(0, MAX_LISTED_PROBLEMS));
  if (fileFailures.length) lines.push("", `读取失败 ${fileFailures.length} 项：`, ...fileFailures.slice(0, MAX_LISTED_PROBLEMS));
  lines.push("", "是否继续导入？");
  return lines.join("\n");
}

function batchResultSummary(
  planned: Array<{ label: string; plan: ImportPlan }>,
  created: number,
  unmatched: string[],
  ambiguous: string[],
  fileFailures: string[],
): string {
  const lines = [`已导入 ${created} 条批注，涉及 ${planned.length} 个 PDF。`];
  const failed = planned.reduce((sum, entry) => sum + entry.plan.failed.length, 0);
  const approx = planned.reduce((sum, entry) => sum + entry.plan.approximate.length, 0);
  const duplicates = planned.reduce((sum, entry) => sum + entry.plan.duplicates, 0);
  if (duplicates) lines.push(`跳过 ${duplicates} 条已存在的批注。`);
  if (approx) lines.push(`${approx} 条按原坐标放置，请打开 PDF 核对。`);
  if (failed) lines.push(`${failed} 条未能导入。`);
  if (unmatched.length) lines.push(`${unmatched.length} 个备份文件未匹配到 PDF。`);
  if (ambiguous.length) lines.push(`${ambiguous.length} 项存在多个匹配。`);
  if (fileFailures.length) lines.push(`${fileFailures.length} 个文件读取失败。`);
  return lines.join("\n");
}

function batchNothingSummary(unmatched: string[], ambiguous: string[], fileFailures: string[]): string {
  const lines = ["没有可导入的批注。"];
  if (unmatched.length) lines.push("", `未匹配 ${unmatched.length} 个文件：`, ...unmatched.slice(0, MAX_LISTED_PROBLEMS));
  if (ambiguous.length) lines.push("", `多义匹配 ${ambiguous.length} 项：`, ...ambiguous.slice(0, MAX_LISTED_PROBLEMS));
  if (fileFailures.length) lines.push("", `读取失败 ${fileFailures.length} 项：`, ...fileFailures.slice(0, MAX_LISTED_PROBLEMS));
  return lines.join("\n");
}

function listProblems(entries: ProblemEntry[], indent = ""): string[] {
  const lines = entries.slice(0, MAX_LISTED_PROBLEMS).map((entry) => {
    const snippet = entry.snippet ? `「${entry.snippet}」` : "";
    return `${indent}• 第 ${entry.pageLabel} 页 ${entry.type}${snippet}：${entry.reason}`;
  });
  if (entries.length > MAX_LISTED_PROBLEMS) {
    lines.push(`${indent}…另有 ${entries.length - MAX_LISTED_PROBLEMS} 条`);
  }
  return lines;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "未知错误");
}
