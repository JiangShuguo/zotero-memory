/** File pickers and simple alerts for annotation transfer. */

declare const ChromeUtils: { importESModule(path: string): unknown };
declare const Services: { prompt: { alert(parent: Window | null, title: string, text: string): void } };

export function chooseBackupSavePath(defaultName: string): Promise<string | undefined> {
  return pickFile("导出 Memory 标注", "save", defaultName.endsWith(".json") ? defaultName : `${defaultName}.json`);
}

export function chooseBackupOpenPath(): Promise<string | undefined> {
  return pickFile("导入 Memory 标注", "open");
}

/** Multi-select JSON backups for batch import. */
export function chooseBackupOpenPaths(ownerWindow?: Window): Promise<string[] | undefined> {
  return pickFiles("选择 Memory 标注备份", "JSON", "*.json", ownerWindow);
}

export function chooseBackupFolder(title: string, ownerWindow?: Window): Promise<string | undefined> {
  return pickFolder(title, ownerWindow);
}

export function alertUser(title: string, message: string, ownerWindow?: Window): void {
  const win = resolveWindow(ownerWindow);
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

export function confirmUser(title: string, message: string, ownerWindow?: Window): boolean {
  const win = resolveWindow(ownerWindow);
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

async function pickFile(
  title: string,
  mode: "open" | "save",
  defaultName?: string,
  ownerWindow?: Window,
): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = resolveWindow(ownerWindow);
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, title, mode === "save" ? fp.modeSave : fp.modeOpen);
  fp.appendFilter("JSON", "*.json");
  if (defaultName) fp.defaultString = defaultName;
  const result = await fp.show();
  const accepted = result === fp.returnOK || (mode === "save" && result === fp.returnReplace);
  return accepted ? String(fp.file) : undefined;
}

async function pickFiles(
  title: string,
  filterName: string,
  filterMask: string,
  ownerWindow?: Window,
): Promise<string[] | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = resolveWindow(ownerWindow);
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, title, fp.modeOpenMultiple);
  fp.appendFilter(filterName, filterMask);
  const result = await fp.show();
  if (result !== fp.returnOK) return undefined;
  const files = Array.isArray(fp.files) ? fp.files.map(String) : [];
  return files.length ? files : undefined;
}

async function pickFolder(title: string, ownerWindow?: Window): Promise<string | undefined> {
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs") as any;
  const fp = new FilePicker();
  const win = resolveWindow(ownerWindow);
  if (!win) throw new Error("没有打开的 Zotero 窗口。");
  fp.init(win, title, fp.modeGetFolder);
  const result = await fp.show();
  return result === fp.returnOK ? String(fp.file) : undefined;
}

/**
 * FilePicker needs a window with browsingContext. Prefer the preferences chrome
 * window so the dialog is not parented to the library window behind Settings.
 */
function resolveWindow(ownerWindow?: Window): any {
  const candidates: Array<Window | null | undefined> = [];
  try {
    candidates.push((Services as any).wm?.getMostRecentWindow?.("zotero:pref"));
  } catch {
    // ignore
  }
  if (ownerWindow && !ownerWindow.closed) {
    candidates.push(ownerWindow);
    try {
      candidates.push((ownerWindow as any).browsingContext?.topChromeWindow);
    } catch {
      // ignore
    }
    try {
      candidates.push(ownerWindow.top);
    } catch {
      // ignore
    }
  }
  candidates.push(
    (Zotero as any).getMainWindow?.(),
    (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView,
  );
  for (const win of candidates) {
    if (win && !win.closed && (win as any).browsingContext) return win;
  }
  return candidates.find((win) => win && !win.closed) ?? null;
}
