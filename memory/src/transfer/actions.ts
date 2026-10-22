import { logError } from "../settings";
import { applyImport, buildBackup, parseBackup, planImport, type ImportPlan, type ProblemEntry } from "./annotations";
import { alertUser, chooseBackupOpenPath, chooseBackupSavePath, confirmUser, showProgress } from "./dialogs";

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
      alertUser("Memory", "请先选中一个 PDF 附件（或打开该 PDF）。");
      return;
    }
    const done = showProgress("正在读取批注和 PDF 文字…");
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
      alertUser("Memory", "请先选中要还原到的 PDF 附件（或打开该 PDF）。");
      return;
    }
    const path = await chooseBackupOpenPath();
    if (!path) return;
    const raw = await (Zotero as any).File.getContentsAsync(path);
    const backup = parseBackup(String(raw));
    const done = showProgress("正在比对 PDF 文字…");
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
    onImported();
    alertUser("Memory", resultSummary(plan, result.created));
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
  exportItem.setAttribute("label", "导出标注备份…");
  const importItem = createXul(doc, "menuitem");
  importItem.id = ITEM_MENU_IDS.import;
  importItem.setAttribute("label", "导入标注备份…");

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
  const pane = (Zotero as any).getActiveZoteroPane?.();
  for (const item of pane?.getSelectedItems?.() ?? []) {
    const pdf = asPdfAttachment(item);
    if (pdf) return pdf;
  }
  for (const reader of (Zotero as any).Reader?._readers ?? []) {
    if (reader?._type !== "pdf" && reader?.type !== "pdf") continue;
    const pdf = asPdfAttachment((Zotero as any).Items?.get?.(reader.itemID));
    if (pdf) return pdf;
  }
  return undefined;
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

function planSummary(plan: ImportPlan): string {
  const lines = [
    plan.exact
      ? `可以还原 ${plan.items.length} 条批注。`
      : `目标 PDF 与备份时的文件不同，已按文字重新定位：可以还原 ${plan.items.length} 条批注。`,
  ];
  if (plan.duplicates) lines.push(`${plan.duplicates} 条已存在，将跳过。`);
  if (plan.approximate.length) {
    lines.push("", `以下 ${plan.approximate.length} 条无法按文字核对，将按原坐标放置：`, ...listProblems(plan.approximate));
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
  if (plan.failed.length) lines.push(`${plan.failed.length} 条未能导入（见导入前的列表）。`);
  return lines.join("\n");
}

function nothingToImport(plan: ImportPlan): string {
  if (!plan.failed.length) {
    return plan.duplicates ? `备份中的 ${plan.duplicates} 条批注都已存在，无需导入。` : "备份中没有批注。";
  }
  const lines = [`没有可导入的批注，${plan.failed.length} 条无法导入：`, ...listProblems(plan.failed)];
  if (plan.duplicates) lines.push("", `另有 ${plan.duplicates} 条已存在。`);
  return lines.join("\n");
}

function listProblems(entries: ProblemEntry[]): string[] {
  const lines = entries.slice(0, MAX_LISTED_PROBLEMS).map((entry) => {
    const snippet = entry.snippet ? `「${entry.snippet}」` : "";
    return `• 第 ${entry.pageLabel} 页 ${entry.type}${snippet}：${entry.reason}`;
  });
  if (entries.length > MAX_LISTED_PROBLEMS) lines.push(`…另有 ${entries.length - MAX_LISTED_PROBLEMS} 条`);
  return lines;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "Unknown error");
}
