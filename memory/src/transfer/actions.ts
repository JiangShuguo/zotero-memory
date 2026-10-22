import { logError } from "../settings";
import { buildBackup, importBackup, parseBackup } from "./annotations";
import { alertUser, chooseBackupOpenPath, chooseBackupSavePath } from "./dialogs";

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
    const backup = await buildBackup(attachment);
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
    const result = await importBackup(attachment, backup);
    onImported();
    alertUser(
      "Memory",
      `已导入 ${result.created} 条批注` + (result.skipped ? `，跳过 ${result.skipped} 条已存在或无效条目` : "") + "。",
    );
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "Unknown error");
}
