/** File pickers and simple alerts for annotation transfer. */

declare const ChromeUtils: { importESModule(path: string): unknown };
declare const Services: { prompt: { alert(parent: Window | null, title: string, text: string): void } };

export async function chooseBackupSavePath(defaultName: string): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, "导出 Memory 标注", fp.modeSave);
  fp.appendFilter("JSON", "*.json");
  fp.defaultString = defaultName.endsWith(".json") ? defaultName : `${defaultName}.json`;
  const result = await fp.show();
  if (result !== fp.returnOK && result !== fp.returnReplace) return undefined;
  return String(fp.file);
}

export async function chooseBackupOpenPath(): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, "导入 Memory 标注", fp.modeOpen);
  fp.appendFilter("JSON", "*.json");
  const result = await fp.show();
  if (result !== fp.returnOK) return undefined;
  return String(fp.file);
}

export function alertUser(title: string, message: string): void {
  const win = (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
  if (win?.Services?.prompt) {
    win.Services.prompt.alert(win, title, message);
    return;
  }
  try {
    (Services as any).prompt.alert(win ?? null, title, message);
  } catch {
    // eslint-disable-next-line no-alert
    alert(`${title}\n\n${message}`);
  }
}
