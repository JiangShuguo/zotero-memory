/** File pickers and simple alerts for annotation transfer. */

declare const ChromeUtils: { importESModule(path: string): unknown };
declare const Services: { prompt: { alert(parent: Window | null, title: string, text: string): void } };

export function chooseBackupSavePath(defaultName: string): Promise<string | undefined> {
  return pickFile("导出 Memory 标注", "save", defaultName.endsWith(".json") ? defaultName : `${defaultName}.json`);
}

export function chooseBackupOpenPath(): Promise<string | undefined> {
  return pickFile("导入 Memory 标注", "open");
}

export function chooseBackupFolder(title: string): Promise<string | undefined> {
  return pickFolder(title);
}

export function alertUser(title: string, message: string): void {
  const win = mainWindow();
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

export function confirmUser(title: string, message: string): boolean {
  const win = mainWindow();
  const prompt = win?.Services?.prompt ?? (Services as any).prompt;
  try {
    return Boolean(prompt.confirm(win ?? null, title, message));
  } catch {
    // eslint-disable-next-line no-alert
    return confirm(`${title}\n\n${message}`);
  }
}

/** A small non-modal "working…" popup; returns its closer. */
export function showProgress(message: string): () => void {
  try {
    const progress = new (Zotero as any).ProgressWindow({ closeOnClick: false });
    progress.changeHeadline("Memory");
    progress.addDescription(message);
    progress.show();
    return () => progress.close();
  } catch {
    return () => undefined;
  }
}

async function pickFile(title: string, mode: "open" | "save", defaultName?: string): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = mainWindow();
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, title, mode === "save" ? fp.modeSave : fp.modeOpen);
  fp.appendFilter("JSON", "*.json");
  if (defaultName) fp.defaultString = defaultName;
  const result = await fp.show();
  const accepted = result === fp.returnOK || (mode === "save" && result === fp.returnReplace);
  return accepted ? String(fp.file) : undefined;
}

async function pickFolder(title: string): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = mainWindow();
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, title, fp.modeGetFolder);
  const result = await fp.show();
  return result === fp.returnOK ? String(fp.file) : undefined;
}

function mainWindow(): any {
  return (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
}
