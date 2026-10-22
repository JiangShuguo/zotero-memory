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

/** Opens a collection-folded PDF picker. Resolves to selected attachment IDs, or undefined if cancelled. */
export async function choosePdfsForExport(): Promise<number[] | undefined> {
  const tree = await buildExportTree();
  if (!tree.length || !countPdfs(tree)) {
    return [];
  }
  return showModal<number[] | undefined>({
    title: "批量导出",
    hint: "按分类展开后勾选 PDF，再点击导出。",
    buildBody(doc, panel) {
      const treeEl = el(doc, "div", "mem-batch-tree");
      for (const node of tree) treeEl.append(renderFolder(doc, node, true));
      panel.append(treeEl);
    },
    primaryLabel: "导出",
    onPrimary(root) {
      const ids = Array.from(root.querySelectorAll("input[data-mem-pdf]:checked"))
        .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
        .map((box) => Number(box.dataset.memPdf))
        .filter((id) => Number.isFinite(id));
      return [...new Set(ids)];
    },
    validatePrimary(selection) {
      if (!selection?.length) return "请先勾选要导出的 PDF。";
      return undefined;
    },
  });
}

/**
 * Opens a batch-import dialog. User picks multiple JSON files; returns the chosen paths
 * (may be empty only if cancelled — empty confirm is blocked).
 */
export async function chooseJsonFilesForImport(
  preview: (paths: string[]) => Promise<ImportMatchRow[]>,
): Promise<string[] | undefined> {
  let rows: ImportMatchRow[] = [];
  return showModal<string[] | undefined>({
    title: "批量导入",
    hint: "选择多个备份 JSON 文件，系统将按文件名或条目题名匹配对应论文。",
    buildBody(doc, panel, api) {
      const toolbar = el(doc, "div", "mem-batch-toolbar");
      const pick = el(doc, "button", "mem-batch-secondary", "选择 JSON 文件") as HTMLButtonElement;
      pick.type = "button";
      const summary = el(doc, "span", "mem-batch-summary", "尚未选择文件");
      toolbar.append(pick, summary);
      const list = el(doc, "div", "mem-batch-match-list");
      list.append(el(doc, "p", "mem-batch-empty", "请先选择备份文件。"));
      panel.append(toolbar, list);

      pick.addEventListener("click", () => {
        void (async () => {
          const { chooseBackupOpenPaths } = await import("./dialogs");
          const paths = await chooseBackupOpenPaths();
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
  });
}

function renderMatchRow(doc: Document, row: ImportMatchRow): HTMLElement {
  const item = el(doc, "div", `mem-batch-match mem-batch-match-${row.status}`);
  const name = el(doc, "div", "mem-batch-match-name", row.fileName);
  let detail = "";
  if (row.status === "matched") detail = `→ ${row.targetLabel ?? ""}`;
  else if (row.status === "unmatched") detail = row.message || "未找到匹配的 PDF";
  else detail = row.message || "无法读取";
  item.append(name, el(doc, "div", "mem-batch-match-detail", detail));
  return item;
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
  select.className = "mem-batch-folder-check";
  select.title = "全选此分类";

  const title = el(doc, "span", "mem-batch-folder-title", node.name);
  const count = countPdfs([node]);
  const badge = el(doc, "span", "mem-batch-folder-count", String(count));
  head.append(toggle, select, title, badge);

  const body = el(doc, "div", "mem-batch-folder-body");
  for (const child of node.children) body.append(renderFolder(doc, child, true));
  for (const pdf of node.pdfs) {
    const row = el(doc, "label", "mem-batch-pdf");
    const box = el(doc, "input") as HTMLInputElement;
    box.type = "checkbox";
    box.dataset.memPdf = String(pdf.id);
    const text = el(doc, "span", "mem-batch-pdf-text");
    text.append(el(doc, "span", "mem-batch-pdf-label", pdf.label));
    if (pdf.detail && pdf.detail !== pdf.label) {
      text.append(el(doc, "span", "mem-batch-pdf-detail", pdf.detail));
    }
    row.append(box, text);
    body.append(row);
  }

  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    const next = folder.dataset.collapsed !== "true";
    folder.dataset.collapsed = String(next);
    toggle.textContent = next ? "▸" : "▾";
  });

  select.addEventListener("change", () => {
    body.querySelectorAll<HTMLInputElement>("input[data-mem-pdf]").forEach((box) => {
      box.checked = select.checked;
    });
    body.querySelectorAll<HTMLInputElement>("input.mem-batch-folder-check").forEach((box) => {
      box.checked = select.checked;
      box.indeterminate = false;
    });
  });

  body.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    syncFolderCheck(folder);
  });

  folder.append(head, body);
  return folder;
}

function syncFolderCheck(folder: HTMLElement): void {
  const select = folder.querySelector<HTMLInputElement>(":scope > .mem-batch-folder-head > .mem-batch-folder-check");
  const boxes = Array.from(folder.querySelectorAll("input[data-mem-pdf]")).filter(
    (node): node is HTMLInputElement => node instanceof HTMLInputElement,
  );
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
  hint: string;
  primaryLabel: string;
  buildBody(doc: Document, panel: HTMLElement, api: { refresh(): void }): void;
  onPrimary(root: HTMLElement): T;
  validatePrimary?(value: T): string | undefined;
}

function showModal<T>(options: ModalOptions<T>): Promise<T | undefined> {
  const win = mainWindow();
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
    head.append(el(doc, "p", "mem-batch-hint", options.hint));

    const body = el(doc, "div", "mem-batch-body");
    const foot = el(doc, "div", "mem-batch-foot");
    const error = el(doc, "div", "mem-batch-error");
    error.hidden = true;
    const cancel = el(doc, "button", "mem-batch-ghost", "取消") as HTMLButtonElement;
    cancel.type = "button";
    const primary = el(doc, "button", "mem-batch-primary", options.primaryLabel) as HTMLButtonElement;
    primary.type = "button";
    foot.append(error, cancel, primary);

    dialog.append(head, body, foot);
    backdrop.append(dialog);

    const close = (value: T | undefined) => {
      doc.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };

    const api = {
      refresh() {
        error.hidden = true;
        error.textContent = "";
      },
    };

    options.buildBody(doc, body, api);

    cancel.addEventListener("click", () => close(undefined));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(undefined);
    });
    primary.addEventListener("click", () => {
      const value = options.onPrimary(dialog);
      const message = options.validatePrimary?.(value);
      if (message) {
        error.hidden = false;
        error.textContent = message;
        return;
      }
      close(value);
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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

function mainWindow(): any {
  return (Zotero as any).getMainWindow?.() ?? (Zotero as any).getActiveZoteroPane?.()?.document?.defaultView;
}

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElementNS(HTML, "style") as HTMLStyleElement;
  style.id = STYLE_ID;
  style.textContent = `
#mem-batch-dialog.mem-batch-backdrop {
  position: fixed;
  inset: 0;
  z-index: 99999;
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
#mem-batch-dialog .mem-batch-secondary {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
#mem-batch-dialog .mem-batch-ghost {
  opacity: 0.85;
}
#mem-batch-dialog .mem-batch-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
#mem-batch-dialog .mem-batch-folder-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 8px;
}
#mem-batch-dialog .mem-batch-folder-head:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
#mem-batch-dialog .mem-batch-folder-toggle {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  line-height: 1;
}
#mem-batch-dialog .mem-batch-folder-title {
  flex: 1;
  font-weight: 600;
}
#mem-batch-dialog .mem-batch-folder-count {
  min-width: 1.4em;
  text-align: center;
  font-size: 0.8rem;
  opacity: 0.55;
}
#mem-batch-dialog .mem-batch-folder-body {
  margin-left: 14px;
  padding-left: 10px;
  border-left: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
#mem-batch-dialog .mem-batch-folder[data-collapsed="true"] > .mem-batch-folder-body {
  display: none;
}
#mem-batch-dialog .mem-batch-pdf {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 8px;
  cursor: pointer;
}
#mem-batch-dialog .mem-batch-pdf:hover {
  background: color-mix(in srgb, currentColor 5%, transparent);
}
#mem-batch-dialog .mem-batch-pdf-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
#mem-batch-dialog .mem-batch-pdf-label {
  line-height: 1.35;
}
#mem-batch-dialog .mem-batch-pdf-detail {
  font-size: 0.82rem;
  opacity: 0.58;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#mem-batch-dialog .mem-batch-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
#mem-batch-dialog .mem-batch-summary {
  font-size: 0.9rem;
  opacity: 0.7;
}
#mem-batch-dialog .mem-batch-match-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
#mem-batch-dialog .mem-batch-match {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 4%, transparent);
}
#mem-batch-dialog .mem-batch-match-matched {
  border-left: 3px solid #1f6feb;
}
#mem-batch-dialog .mem-batch-match-unmatched,
#mem-batch-dialog .mem-batch-match-error {
  border-left: 3px solid #b42318;
}
#mem-batch-dialog .mem-batch-match-name {
  font-weight: 600;
  word-break: break-all;
}
#mem-batch-dialog .mem-batch-match-detail {
  margin-top: 2px;
  font-size: 0.86rem;
  opacity: 0.72;
}
#mem-batch-dialog .mem-batch-empty {
  margin: 24px 8px;
  text-align: center;
  opacity: 0.55;
}
`;
  (doc.head ?? doc.documentElement).append(style);
}
