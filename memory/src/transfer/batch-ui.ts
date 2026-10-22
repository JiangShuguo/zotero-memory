/** Modal dialogs for batch annotation export / import. */

import { logError } from "../settings";

const STYLE_ID = "mem-batch-dialog-style";
const HTML = "http://www.w3.org/1999/xhtml";

export interface ExportPdfRow {
  id: number;
  label: string;
  detail: string;
}

export interface ExportFolderNode {
  key: string;
  name: string;
  pdfs: ExportPdfRow[];
  children: ExportFolderNode[];
}

export interface ImportMatchRow {
  path: string;
  fileName: string;
  status: "matched" | "unmatched" | "error";
  targetLabel?: string;
  message?: string;
}

export interface ExportSelection {
  ids: number[];
  folder: string;
}

/** Opens a collection-folded PDF picker, then a folder picker. Cancel at either step returns undefined. */
export async function choosePdfsForExport(ownerWindow?: Window): Promise<ExportSelection | undefined> {
  const tree = await buildExportTree();
  if (!tree.length || !countPdfs(tree)) {
    const { alertUser } = await import("./dialogs");
    alertUser("Memory", "文库中没有可导出的 PDF。", ownerWindow);
    return undefined;
  }
  return showModal<ExportSelection>(
    {
      title: "批量导出",
      buildBody(doc, panel) {
        const treeEl = el(doc, "div", "mem-batch-tree");
        for (const node of tree) treeEl.append(renderFolder(doc, node, true));
        panel.append(treeEl);
      },
      primaryLabel: "导出",
      onPrimary(root) {
        return { ids: collectCheckedPdfIds(root), folder: "" };
      },
      validatePrimary(selection) {
        if (!selection?.ids.length) return "请先勾选要导出的 PDF。";
        return undefined;
      },
      async afterValidate(selection, host, overlay) {
        const { chooseBackupFolder } = await import("./dialogs");
        // Native file dialogs can sit behind a full-window overlay; hide it while picking.
        overlay.style.visibility = "hidden";
        try {
          const folder = await chooseBackupFolder("选择导出目录", host);
          if (!folder) return undefined;
          return { ids: selection.ids, folder };
        } finally {
          overlay.style.visibility = "";
        }
      },
    },
    ownerWindow,
  );
}

/**
 * Opens a batch-import dialog. User picks multiple JSON files; returns the chosen paths
 * (may be empty only if cancelled — empty confirm is blocked).
 */
export async function chooseJsonFilesForImport(
  preview: (paths: string[]) => Promise<ImportMatchRow[]>,
  ownerWindow?: Window,
): Promise<string[] | undefined> {
  let rows: ImportMatchRow[] = [];
  return showModal<string[] | undefined>(
    {
      title: "批量导入",
      buildBody(doc, panel, api) {
        const toolbar = el(doc, "div", "mem-batch-toolbar");
        const pick = el(doc, "button", "mem-batch-pick") as HTMLButtonElement;
        pick.type = "button";
        pick.append(
          svgIcon(
            doc,
            "M3.5 4.5h4l1.2 1.5H12.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z",
          ),
          doc.createTextNode("选择 JSON 文件"),
        );
        const summary = el(doc, "span", "mem-batch-summary", "尚未选择文件");
        toolbar.append(pick, summary);
        const list = el(doc, "div", "mem-batch-match-list");
        list.append(el(doc, "p", "mem-batch-empty", "请先选择备份文件。"));
        panel.append(toolbar, list);

        pick.addEventListener("click", () => {
          void (async () => {
            const backdrop = doc.getElementById("mem-batch-dialog") as HTMLElement | null;
            if (backdrop) backdrop.style.visibility = "hidden";
            let paths: string[] | undefined;
            try {
              const { chooseBackupOpenPaths } = await import("./dialogs");
              paths = await chooseBackupOpenPaths(ownerWindow);
            } finally {
              if (backdrop) backdrop.style.visibility = "";
            }
            if (!paths?.length) return;
            pick.disabled = true;
            summary.textContent = "正在匹配…";
            list.replaceChildren(el(doc, "p", "mem-batch-empty", "正在匹配…"));
            try {
              rows = await preview(paths);
            } catch (error) {
              logError(error);
              rows = paths.map((path) => ({
                path,
                fileName: path.replace(/^.*[\\/]/, ""),
                status: "error" as const,
                message: error instanceof Error ? error.message : String(error),
              }));
            } finally {
              pick.disabled = false;
            }
            const matched = rows.filter((row) => row.status === "matched").length;
            summary.textContent = `已选 ${rows.length} 个文件，匹配 ${matched} 个`;
            list.replaceChildren(...rows.map((row) => renderMatchRow(doc, row)));
            api.refresh();
          })();
        });
      },
      primaryLabel: "导入",
      onPrimary() {
        return rows.filter((row) => row.status === "matched").map((row) => row.path);
      },
      validatePrimary(selection) {
        if (!rows.length) return "请先选择备份文件。";
        if (!selection?.length) return "没有可导入的匹配项。";
        return undefined;
      },
    },
    ownerWindow,
  );
}

/** Avoid `instanceof HTMLInputElement` — it fails across XUL/HTML document realms. */
function collectCheckedPdfIds(root: ParentNode): number[] {
  const ids: number[] = [];
  for (const node of Array.from(root.querySelectorAll("input[data-mem-pdf]"))) {
    const input = node as HTMLInputElement;
    if (!input.checked) continue;
    const id = Number(input.getAttribute("data-mem-pdf") || "");
    if (Number.isFinite(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

function renderMatchRow(doc: Document, row: ImportMatchRow): HTMLElement {
  const item = el(doc, "div", `mem-batch-match mem-batch-match-${row.status}`);
  const badge = el(doc, "span", "mem-batch-match-badge");
  badge.textContent = row.status === "matched" ? "匹配" : row.status === "unmatched" ? "未匹配" : "失败";
  if (row.fileName) badge.title = row.fileName;
  item.append(badge);
  return item;
}

function svgIcon(doc: Document, pathD: string): SVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("mem-batch-pick-icon");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathD);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function renderFolder(doc: Document, node: ExportFolderNode, collapsed: boolean): HTMLElement {
  const folder = el(doc, "div", "mem-batch-folder");
  folder.dataset.collapsed = collapsed ? "true" : "false";

  const head = el(doc, "div", "mem-batch-folder-head");
  const toggle = el(doc, "button", "mem-batch-folder-toggle") as HTMLButtonElement;
  toggle.type = "button";
  toggle.setAttribute("aria-label", "展开或折叠");
  toggle.textContent = "▸";

  const select = el(doc, "input") as HTMLInputElement;
  select.type = "checkbox";
  select.className = "mem-batch-check mem-batch-folder-check";
  select.title = "全选此分类";

  const title = el(doc, "span", "mem-batch-folder-title", node.name);
  const count = countPdfs([node]);
  const badge = el(doc, "span", "mem-batch-folder-count", String(count));
  head.append(toggle, select, title, badge);

  const body = el(doc, "div", "mem-batch-folder-body");
  for (const child of node.children) body.append(renderFolder(doc, child, true));
  for (const pdf of node.pdfs) {
    const row = el(doc, "label", "mem-batch-pdf");
    const spacer = el(doc, "span", "mem-batch-row-spacer");
    const box = el(doc, "input") as HTMLInputElement;
    box.type = "checkbox";
    box.className = "mem-batch-check";
    box.setAttribute("data-mem-pdf", String(pdf.id));
    const text = el(doc, "span", "mem-batch-pdf-text");
    text.append(el(doc, "span", "mem-batch-pdf-label", pdf.label));
    if (pdf.detail && pdf.detail !== pdf.label) {
      text.append(el(doc, "span", "mem-batch-pdf-detail", pdf.detail));
    }
    row.append(spacer, box, text);
    body.append(row);
  }

  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = folder.dataset.collapsed !== "true";
    folder.dataset.collapsed = String(next);
    toggle.textContent = next ? "▸" : "▾";
  });

  select.addEventListener("change", () => {
    body.querySelectorAll("input[data-mem-pdf]").forEach((node) => {
      (node as HTMLInputElement).checked = select.checked;
    });
    body.querySelectorAll("input.mem-batch-folder-check").forEach((node) => {
      const box = node as HTMLInputElement;
      box.checked = select.checked;
      box.indeterminate = false;
    });
  });

  body.addEventListener("change", (event) => {
    const target = event.target as Element | null;
    if (!target || target.localName !== "input") return;
    syncFolderCheck(folder);
  });

  folder.append(head, body);
  return folder;
}

function syncFolderCheck(folder: HTMLElement): void {
  const select = folder.querySelector(":scope > .mem-batch-folder-head > .mem-batch-folder-check") as HTMLInputElement | null;
  const boxes = Array.from(folder.querySelectorAll("input[data-mem-pdf]")) as HTMLInputElement[];
  if (!select || !boxes.length) return;
  const checked = boxes.filter((box) => box.checked).length;
  select.checked = checked === boxes.length;
  select.indeterminate = checked > 0 && checked < boxes.length;
}

async function buildExportTree(): Promise<ExportFolderNode[]> {
  const libraries = (Zotero as any).Libraries?.getAll?.() ?? [];
  const roots: ExportFolderNode[] = [];
  for (const library of libraries) {
    const libraryID = library.libraryID;
    const name = String(library.name || (library.isGroup ? "群组文库" : "我的文库"));
    const topCollections = (Zotero as any).Collections.getByLibrary(libraryID, false) ?? [];
    const children: ExportFolderNode[] = [];
    for (const collection of topCollections) {
      children.push(await folderFromCollection(collection));
    }
    const unfiled = await unfiledPdfs(libraryID);
    if (unfiled.length) {
      children.push({
        key: `unfiled-${libraryID}`,
        name: "未分类",
        pdfs: unfiled,
        children: [],
      });
    }
    if (!children.length) continue;
    roots.push({
      key: `lib-${libraryID}`,
      name,
      pdfs: [],
      children,
    });
  }
  return roots;
}

async function folderFromCollection(collection: any): Promise<ExportFolderNode> {
  const children: ExportFolderNode[] = [];
  for (const child of collection.getChildCollections?.(false) ?? []) {
    children.push(await folderFromCollection(child));
  }
  const pdfs: ExportPdfRow[] = [];
  const seen = new Set<number>();
  for (const item of collection.getChildItems?.(false, false) ?? []) {
    for (const pdf of pdfsFromItem(item)) {
      if (seen.has(pdf.id)) continue;
      seen.add(pdf.id);
      pdfs.push(pdf);
    }
  }
  return {
    key: `col-${collection.id}`,
    name: String(collection.name || "分类"),
    pdfs,
    children,
  };
}

async function unfiledPdfs(libraryID: number): Promise<ExportPdfRow[]> {
  let items: any[] = [];
  try {
    items = (await (Zotero as any).Items.getAll(libraryID, true)) ?? [];
  } catch (error) {
    logError(error);
    return [];
  }
  const rows: ExportPdfRow[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (!item?.isRegularItem?.()) continue;
    const collections: number[] = item.getCollections?.() ?? [];
    if (collections.length) continue;
    for (const pdf of pdfsFromItem(item)) {
      if (seen.has(pdf.id)) continue;
      seen.add(pdf.id);
      rows.push(pdf);
    }
  }
  return rows;
}

function pdfsFromItem(item: any): ExportPdfRow[] {
  if (!item) return [];
  if (item.isPDFAttachment?.()) return [pdfRow(item)];
  if (!item.isRegularItem?.()) return [];
  const rows: ExportPdfRow[] = [];
  for (const id of item.getAttachments?.() ?? []) {
    const child = (Zotero as any).Items.get(id);
    if (child?.isPDFAttachment?.()) rows.push(pdfRow(child, item));
  }
  return rows;
}

function pdfRow(attachment: any, parent?: any): ExportPdfRow {
  const parentItem =
    parent ??
    attachment.parentItem ??
    (attachment.parentID ? (Zotero as any).Items.get(attachment.parentID) : undefined);
  const title = String(parentItem?.getField?.("title") ?? "").trim();
  const filename = String(attachment.attachmentFilename || "").trim();
  return {
    id: attachment.id,
    label: title || filename || `PDF ${attachment.id}`,
    detail: title && filename && title !== filename ? filename : "",
  };
}

function countPdfs(nodes: ExportFolderNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.pdfs.length + countPdfs(node.children);
  }
  return total;
}

interface ModalOptions<T> {
  title: string;
  hint?: string;
  primaryLabel: string;
  buildBody(doc: Document, panel: HTMLElement, api: { refresh(): void }): void;
  onPrimary(root: HTMLElement): T;
  validatePrimary?(value: T): string | undefined;
  /** Runs after validation; return a value to close, or undefined to keep the dialog open. */
  afterValidate?(value: T, hostWindow: Window, overlay: HTMLElement): Promise<T | undefined>;
}

function showModal<T>(options: ModalOptions<T>, ownerWindow?: Window): Promise<T | undefined> {
  // Prefer the preferences pane window so the dialog is not buried under Settings.
  const win = resolveHostWindow(ownerWindow);
  if (!win) return Promise.resolve(undefined);
  const doc = win.document;
  ensureStyles(doc);

  return new Promise((resolve) => {
    const existing = doc.getElementById("mem-batch-dialog");
    existing?.remove();

    const backdrop = el(doc, "div", "mem-batch-backdrop");
    backdrop.id = "mem-batch-dialog";

    const dialog = el(doc, "div", "mem-batch-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const head = el(doc, "div", "mem-batch-head");
    head.append(el(doc, "h1", "mem-batch-title", options.title));
    if (options.hint) head.append(el(doc, "p", "mem-batch-hint", options.hint));

    const body = el(doc, "div", "mem-batch-body");
    const foot = el(doc, "div", "mem-batch-foot");
    const error = el(doc, "div", "mem-batch-error");
    error.hidden = true;
    error.setAttribute("hidden", "true");
    const cancel = el(doc, "button", "mem-batch-ghost", "取消") as HTMLButtonElement;
    cancel.type = "button";
    const primary = el(doc, "button", "mem-batch-primary", options.primaryLabel) as HTMLButtonElement;
    primary.type = "button";
    foot.append(error, cancel, primary);

    dialog.append(head, body, foot);
    backdrop.append(dialog);

    let busy = false;
    const close = (value: T | undefined) => {
      doc.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };

    const showError = (message: string) => {
      error.hidden = false;
      error.removeAttribute("hidden");
      error.textContent = message;
    };

    const api = {
      refresh() {
        error.hidden = true;
        error.setAttribute("hidden", "true");
        error.textContent = "";
      },
    };

    options.buildBody(doc, body, api);

    cancel.addEventListener("click", () => {
      if (!busy) close(undefined);
    });
    backdrop.addEventListener("click", (event) => {
      if (!busy && event.target === backdrop) close(undefined);
    });
    primary.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (busy) return;
        const value = options.onPrimary(dialog);
        const message = options.validatePrimary?.(value);
        if (message) {
          showError(message);
          return;
        }
        api.refresh();
        if (!options.afterValidate) {
          close(value);
          return;
        }
        busy = true;
        primary.disabled = true;
        cancel.disabled = true;
        try {
          const next = await options.afterValidate(value, win, backdrop);
          if (next === undefined) return;
          close(next);
        } catch (err) {
          logError(err);
          showError(err instanceof Error ? err.message : String(err));
        } finally {
          busy = false;
          primary.disabled = false;
          cancel.disabled = false;
        }
      })();
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        close(undefined);
      }
    };
    doc.addEventListener("keydown", onKey);

    const host = doc.documentElement ?? doc.body;
    host.append(backdrop);
    primary.focus();
  });
}

function el(doc: Document, tag: string, className?: string, text?: string): HTMLElement {
  const node = doc.createElementNS(HTML, tag) as HTMLElement;
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Host the overlay inside the preferences UI — never the library main window,
 * or the dialog appears behind the Settings window.
 *
 * Prefer: click-owner pane → Memory pane inside `zotero:pref` → prefs chrome → main.
 */
function resolveHostWindow(ownerWindow?: Window): Window | undefined {
  if (ownerWindow && !ownerWindow.closed) return ownerWindow;

  try {
    const prefs = (Services as any).wm?.getMostRecentWindow?.("zotero:pref");
    if (prefs && !prefs.closed) {
      const pane = findMemoryPaneWindow(prefs);
      if (pane) return pane;
      return prefs;
    }
  } catch {
    // Services may be unavailable in some scopes
  }

  return mainWindow();
}

function findMemoryPaneWindow(prefsWin: Window): Window | undefined {
  try {
    const doc = prefsWin.document;
    for (const browser of Array.from(doc.getElementsByTagName("browser"))) {
      const content = (browser as any).contentWindow as Window | null;
      if (content?.document?.getElementById?.("zotero-prefpane-memory")) return content;
    }
    for (const iframe of Array.from(doc.getElementsByTagName("iframe"))) {
      const content = (iframe as HTMLIFrameElement).contentWindow;
      if (content?.document?.getElementById?.("zotero-prefpane-memory")) return content;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function mainWindow(): any {
  return (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
}

declare const Services: {
  wm: {
    getMostRecentWindow(type: string | null): Window | null;
  };
};

function ensureStyles(doc: Document): void {
  doc.getElementById(STYLE_ID)?.remove();
  const style = doc.createElementNS(HTML, "style") as HTMLStyleElement;
  style.id = STYLE_ID;
  style.textContent = `
#mem-batch-dialog.mem-batch-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, black 35%, transparent);
  font: message-box;
  color: var(--color-primary, #1f2328);
}
#mem-batch-dialog .mem-batch-dialog {
  width: min(560px, calc(100vw - 48px));
  max-height: min(640px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--material-background, #fff);
  box-shadow: 0 18px 48px color-mix(in srgb, black 28%, transparent);
  overflow: hidden;
}
#mem-batch-dialog .mem-batch-head {
  padding: 18px 20px 10px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
#mem-batch-dialog .mem-batch-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 650;
}
#mem-batch-dialog .mem-batch-hint {
  margin: 6px 0 0;
  font-size: 0.9rem;
  opacity: 0.72;
  line-height: 1.4;
}
#mem-batch-dialog .mem-batch-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px 8px;
}
#mem-batch-dialog .mem-batch-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 16px 16px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
#mem-batch-dialog .mem-batch-error {
  margin-right: auto;
  color: #b42318;
  font-size: 0.88rem;
  max-width: 55%;
}
#mem-batch-dialog .mem-batch-error[hidden] {
  display: none !important;
}
#mem-batch-dialog button {
  appearance: none;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  background: transparent;
  color: inherit;
  padding: 6px 12px;
  cursor: pointer;
}
#mem-batch-dialog .mem-batch-primary {
  border-color: transparent;
  background: #1f6feb;
  color: #fff;
}
#mem-batch-dialog .mem-batch-primary:disabled,
#mem-batch-dialog .mem-batch-ghost:disabled {
  opacity: 0.55;
  cursor: default;
}
#mem-batch-dialog .mem-batch-secondary {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
#mem-batch-dialog .mem-batch-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid color-mix(in srgb, #1f6feb 28%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, #1f6feb 8%, transparent);
  color: #1f6feb;
  font-weight: 600;
}
#mem-batch-dialog .mem-batch-pick:hover {
  background: color-mix(in srgb, #1f6feb 14%, transparent);
}
#mem-batch-dialog .mem-batch-pick:disabled {
  opacity: 0.55;
  cursor: default;
}
#mem-batch-dialog .mem-batch-pick-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}
#mem-batch-dialog .mem-batch-ghost {
  opacity: 0.85;
}
#mem-batch-dialog .mem-batch-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#mem-batch-dialog .mem-batch-folder-head,
#mem-batch-dialog .mem-batch-pdf {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 4px 6px;
  border-radius: 6px;
  box-sizing: border-box;
}
#mem-batch-dialog .mem-batch-folder-head:hover,
#mem-batch-dialog .mem-batch-pdf:hover {
  background: color-mix(in srgb, currentColor 5%, transparent);
}
#mem-batch-dialog .mem-batch-folder-toggle,
#mem-batch-dialog .mem-batch-row-spacer {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  padding: 0;
  border: none;
  background: transparent;
  line-height: 18px;
  text-align: center;
}
#mem-batch-dialog .mem-batch-check,
#mem-batch-dialog input[type="checkbox"] {
  width: 14px !important;
  height: 14px !important;
  margin: 0 !important;
  flex: 0 0 14px;
  accent-color: #1f6feb;
}
#mem-batch-dialog .mem-batch-folder-title {
  flex: 1;
  font-weight: 600;
  line-height: 1.3;
}
#mem-batch-dialog .mem-batch-folder-count {
  min-width: 1.4em;
  text-align: center;
  font-size: 0.8rem;
  opacity: 0.55;
}
#mem-batch-dialog .mem-batch-folder-body {
  margin-left: 9px;
  padding-left: 10px;
  border-left: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
#mem-batch-dialog .mem-batch-folder[data-collapsed="true"] > .mem-batch-folder-body {
  display: none;
}
#mem-batch-dialog .mem-batch-pdf {
  cursor: pointer;
}
#mem-batch-dialog .mem-batch-pdf-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
#mem-batch-dialog .mem-batch-pdf-label {
  line-height: 1.3;
}
#mem-batch-dialog .mem-batch-pdf-detail {
  font-size: 0.8rem;
  opacity: 0.58;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.25;
}
#mem-batch-dialog .mem-batch-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
#mem-batch-dialog .mem-batch-summary {
  font-size: 0.9rem;
  opacity: 0.68;
}
#mem-batch-dialog .mem-batch-match-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
#mem-batch-dialog .mem-batch-match {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
}
#mem-batch-dialog .mem-batch-match-badge {
  display: inline-block;
  min-width: 44px;
  padding: 4px 10px;
  border-radius: 999px;
  text-align: center;
  font-size: 0.78rem;
  font-weight: 650;
  letter-spacing: 0.02em;
  line-height: 1.45;
}
#mem-batch-dialog .mem-batch-match-matched .mem-batch-match-badge {
  background: color-mix(in srgb, #1f6feb 16%, transparent);
  color: #1f6feb;
}
#mem-batch-dialog .mem-batch-match-unmatched .mem-batch-match-badge,
#mem-batch-dialog .mem-batch-match-error .mem-batch-match-badge {
  background: color-mix(in srgb, #b42318 14%, transparent);
  color: #b42318;
}
#mem-batch-dialog .mem-batch-empty {
  margin: 24px 8px;
  text-align: center;
  opacity: 0.55;
}
`;
  (doc.head ?? doc.documentElement).append(style);
}
