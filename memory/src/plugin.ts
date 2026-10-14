import { ADDON_ID, ADDON_NAME, CHROME_PACKAGE } from "./constants";
import { ANNOTATION_TYPES, type AnnotationType } from "./model/types";
import { ReaderSession } from "./reader/session";
import { TOOLBAR_CSS, TOOLBAR_STYLE_ID } from "./reader/styles";
import { logError, readSettings, writeCompactNotes, writeEnabled, writeKind, type Settings } from "./settings";
import { NoteStore } from "./store";
import { buildBackup, importBackup, parseBackup } from "./transfer/annotations";
import { alertUser, chooseBackupOpenPath, chooseBackupSavePath } from "./transfer/dialogs";

const PANE_ID = "zotero-prefpane-memory";
const BUTTON_CLASS = "mem-toolbar-toggle";
const FALLBACK_SECTION_CLASS = "mem-fallback-section";
const FALLBACK_BUTTON_DELAY_MS = 350;
const ITEM_MENU_IDS = {
  separator: "mem-itemmenu-separator",
  export: "mem-itemmenu-export",
  import: "mem-itemmenu-import",
} as const;

const BUTTON_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="2.2" y="3" width="11" height="18" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M5 8h6M5 11.5h5M5 15h6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <path d="M13.2 12H16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  <rect x="16" y="7.5" width="6" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/>
</svg>`;

/** Connects Memory to Zotero: reader events, the notifier, preferences and the toolbar button. */
export class MemoryPlugin {
  private readonly store = new NoteStore();
  private readonly sessions = new Map<object, ReaderSession>();
  private readonly preferenceDocuments = new Set<Document>();
  private settings: Settings = readSettings();
  private paneID?: string;
  private notifierID?: string;
  private running = false;
  private readonly itemMenuCleanups: Array<() => void> = [];

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.settings = readSettings();
    await this.registerPane();
    const readers = (Zotero as any).Reader;
    readers.registerEventListener("renderToolbar", this.onRenderToolbar, ADDON_ID);
    readers.registerEventListener("createAnnotationContextMenu", this.onAnnotationMenu, ADDON_ID);
    this.notifierID = Zotero.Notifier.registerObserver(this.notifier as any, ["item", "tab"], ADDON_ID);
    for (const win of (Zotero as any).getMainWindows?.() ?? []) this.bindItemMenu(win);
    for (const reader of readers._readers ?? []) {
      if (!isPdf(reader)) continue;
      void this.session(reader);
      setTimeout(() => this.addFallbackButton(reader), FALLBACK_BUTTON_DELAY_MS);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const readers = (Zotero as any).Reader;
    readers?._unregisterEventListenerByPluginID?.(ADDON_ID);
    if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
    this.notifierID = undefined;
    for (const cleanup of this.itemMenuCleanups.splice(0)) cleanup();
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
    this.preferenceDocuments.clear();
    if (this.paneID) {
      try {
        (Zotero as any).PreferencePanes?.unregister?.(this.paneID);
      } catch (error) {
        logError(error);
      }
      this.paneID = undefined;
    }
    for (const reader of readers?._readers ?? []) removeToolbarButtons(reader?._iframeWindow?.document);
  }

  /** Called when a Zotero main window finishes loading. */
  onMainWindowLoad(win: Window): void {
    if (!this.running) return;
    this.bindItemMenu(win);
  }

  /** Called by the preference pane once it has loaded. */
  bindPreferences(win: Window): void {
    const root = win.document.getElementById(PANE_ID);
    if (!root) return;
    this.preferenceDocuments.add(win.document);
    root.querySelectorAll<HTMLInputElement>("[data-mem-type]").forEach((box) => {
      const kind = box.dataset.memType as AnnotationType | undefined;
      if (!kind || !ANNOTATION_TYPES.includes(kind) || box.dataset.memBound === "true") return;
      box.dataset.memBound = "true";
      box.addEventListener("command", () => this.setKind(kind, box.checked));
      box.addEventListener("change", () => this.setKind(kind, box.checked));
    });
    const compact = root.querySelector<HTMLInputElement>('[data-mem-setting="compact-notes"]');
    if (compact && compact.dataset.memBound !== "true") {
      compact.dataset.memBound = "true";
      compact.addEventListener("command", () => this.setCompactNotes(compact.checked));
      compact.addEventListener("change", () => this.setCompactNotes(compact.checked));
    }
    const exportBtn = root.querySelector<HTMLButtonElement>('[data-mem-action="export"]');
    if (exportBtn && exportBtn.dataset.memBound !== "true") {
      exportBtn.dataset.memBound = "true";
      exportBtn.addEventListener("click", () => void this.exportAnnotations());
    }
    const importBtn = root.querySelector<HTMLButtonElement>('[data-mem-action="import"]');
    if (importBtn && importBtn.dataset.memBound !== "true") {
      importBtn.dataset.memBound = "true";
      importBtn.addEventListener("click", () => void this.importAnnotations());
    }
    this.syncPreferences();
  }

  // -------------------------------------------------------------------------

  private readonly onRenderToolbar = (event: any) => {
    const { reader, doc, append } = event;
    if (!isPdf(reader)) return;
    append(this.makeButton(doc));
    void this.session(reader);
  };

  private readonly onAnnotationMenu = (event: any) => {
    const { reader, params, append } = event;
    if (!isPdf(reader)) return;
    const ids: string[] = Array.isArray(params?.ids) ? params.ids.map(String) : [];
    append({
      label: "页边标注",
      disabled: ids.length === 0,
      onCommand: () => void this.reveal(reader, ids),
    });
  };

  private readonly notifier = {
    notify: (event: string, type: string) => {
      this.dropClosedReaders();
      if (type !== "item" || !["add", "modify", "delete", "trash"].includes(event)) return;
      for (const session of this.sessions.values()) session.refresh();
    },
  };

  private async session(reader: any): Promise<ReaderSession | undefined> {
    if (!this.running || !isPdf(reader)) return undefined;
    let session = this.sessions.get(reader);
    if (!session) {
      session = new ReaderSession(reader, this.store, this.settings);
      this.sessions.set(reader, session);
    }
    try {
      await session.start();
      return session;
    } catch (error) {
      if (this.sessions.get(reader) === session) this.sessions.delete(reader);
      session.destroy();
      logError(error);
      return undefined;
    }
  }

  private async reveal(reader: any, keys: string[]): Promise<void> {
    if (!this.settings.enabled) this.setEnabled(true);
    const session = await this.session(reader);
    await session?.reveal(keys);
  }

  private setEnabled(enabled: boolean): void {
    writeEnabled(enabled);
    this.applySettings({ ...this.settings, enabled });
  }

  private setKind(kind: AnnotationType, visible: boolean): void {
    if (this.settings.kinds.has(kind) === visible) return;
    const kinds = new Set(this.settings.kinds);
    if (visible) kinds.add(kind);
    else kinds.delete(kind);
    writeKind(kind, visible);
    this.applySettings({ ...this.settings, kinds });
  }

  private setCompactNotes(enabled: boolean): void {
    if (this.settings.compactNotes === enabled) return;
    writeCompactNotes(enabled);
    this.applySettings({ ...this.settings, compactNotes: enabled });
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    for (const session of this.sessions.values()) session.setSettings(settings);
    this.syncButtons();
    this.syncPreferences();
  }

  private async registerPane(): Promise<void> {
    const panes = (Zotero as any).PreferencePanes;
    if (!panes?.register) return;
    try {
      this.paneID = await panes.register({
        pluginID: ADDON_ID,
        id: "memory-preferences",
        label: ADDON_NAME,
        src: `chrome://${CHROME_PACKAGE}/content/preferences.xhtml`,
        image: `chrome://${CHROME_PACKAGE}/content/icons/icon.png`,
        stylesheets: [`chrome://${CHROME_PACKAGE}/content/preferences.css`],
      });
    } catch (error) {
      logError(error);
    }
  }

  private makeButton(doc: Document): HTMLButtonElement {
    if (!doc.getElementById(TOOLBAR_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = TOOLBAR_STYLE_ID;
      style.textContent = TOOLBAR_CSS;
      (doc.head ?? doc.documentElement).append(style);
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.className = `toolbar-button ${BUTTON_CLASS}`;
    button.innerHTML = BUTTON_ICON;
    button.addEventListener("click", () => this.setEnabled(!this.settings.enabled));
    this.syncButton(button);
    return button;
  }

  /** Older readers without the renderToolbar event get the button in the custom section. */
  private addFallbackButton(reader: any): void {
    const doc = reader?._iframeWindow?.document as Document | undefined;
    if (!this.running || !doc || doc.querySelector(`.${BUTTON_CLASS}`)) return;
    const slot = doc.querySelector<HTMLElement>(".toolbar .end .custom-sections");
    if (!slot) return;
    const section = doc.createElement("div");
    section.className = `section ${FALLBACK_SECTION_CLASS}`;
    section.append(this.makeButton(doc));
    slot.append(section);
  }

  private syncButtons(): void {
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      const doc = reader?._iframeWindow?.document as Document | undefined;
      doc?.querySelectorAll<HTMLButtonElement>(`.${BUTTON_CLASS}`).forEach((button) => this.syncButton(button));
    }
  }

  private syncButton(button: HTMLButtonElement): void {
    const enabled = this.settings.enabled;
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? "Memory is on. Click to hide the cards." : "Memory is off. Click to show the cards.";
    button.setAttribute("aria-label", button.title);
  }

  private syncPreferences(): void {
    for (const doc of [...this.preferenceDocuments]) {
      const root = doc.getElementById(PANE_ID);
      if (!root) {
        this.preferenceDocuments.delete(doc);
        continue;
      }
      root.querySelectorAll<HTMLInputElement>("[data-mem-type]").forEach((box) => {
        const kind = box.dataset.memType as AnnotationType | undefined;
        if (kind) box.checked = this.settings.kinds.has(kind);
      });
      const compact = root.querySelector<HTMLInputElement>('[data-mem-setting="compact-notes"]');
      if (compact) compact.checked = this.settings.compactNotes;
    }
  }

  private dropClosedReaders(): void {
    const live = new Set<object>((Zotero as any).Reader?._readers ?? []);
    for (const [reader, session] of this.sessions) {
      if (live.has(reader)) continue;
      session.destroy();
      this.sessions.delete(reader);
    }
  }

  private bindItemMenu(win: Window): void {
    const doc = win.document;
    const menu = doc.getElementById("zotero-itemmenu");
    if (!menu || menu.getAttribute("data-mem-bound") === "true") return;
    menu.setAttribute("data-mem-bound", "true");

    const separator = createXul(doc, "menuseparator");
    separator.id = ITEM_MENU_IDS.separator;
    const exportItem = createXul(doc, "menuitem");
    exportItem.id = ITEM_MENU_IDS.export;
    exportItem.setAttribute("label", "导出标注备份…");
    const importItem = createXul(doc, "menuitem");
    importItem.id = ITEM_MENU_IDS.import;
    importItem.setAttribute("label", "导入标注备份…");

    const onExport = () => void this.exportAnnotations();
    const onImport = () => void this.importAnnotations();
    const onShowing = () => {
      const enabled = Boolean(resolvePdfAttachment());
      exportItem.setAttribute("disabled", enabled ? "false" : "true");
      importItem.setAttribute("disabled", enabled ? "false" : "true");
    };

    exportItem.addEventListener("command", onExport);
    importItem.addEventListener("command", onImport);
    menu.addEventListener("popupshowing", onShowing);
    menu.append(separator, exportItem, importItem);

    this.itemMenuCleanups.push(() => {
      menu.removeEventListener("popupshowing", onShowing);
      exportItem.removeEventListener("command", onExport);
      importItem.removeEventListener("command", onImport);
      separator.remove();
      exportItem.remove();
      importItem.remove();
      menu.removeAttribute("data-mem-bound");
    });
  }

  private async exportAnnotations(): Promise<void> {
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

  private async importAnnotations(): Promise<void> {
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
      for (const session of this.sessions.values()) session.refresh();
      alertUser(
        "Memory",
        `已导入 ${result.created} 条批注` + (result.skipped ? `，跳过 ${result.skipped} 条已存在或无效条目` : "") + "。",
      );
    } catch (error) {
      logError(error);
      alertUser("Memory", errorMessage(error));
    }
  }
}

function createXul(doc: Document, name: string): XULElement {
  const create = (doc as any).createXULElement?.bind(doc) as ((tag: string) => XULElement) | undefined;
  if (create) return create(name);
  return doc.createElementNS("http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul", name) as XULElement;
}

function resolvePdfAttachment(): any | undefined {
  const pane = (Zotero as any).getActiveZoteroPane?.();
  for (const item of pane?.getSelectedItems?.() ?? []) {
    const pdf = asPdfAttachment(item);
    if (pdf) return pdf;
  }
  for (const reader of (Zotero as any).Reader?._readers ?? []) {
    if (!isPdf(reader)) continue;
    const item = (Zotero as any).Items?.get?.(reader.itemID);
    const pdf = asPdfAttachment(item);
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

function removeToolbarButtons(doc: Document | undefined): void {
  if (!doc) return;
  doc.querySelectorAll(`.${BUTTON_CLASS}, .${FALLBACK_SECTION_CLASS}`).forEach((node) => node.remove());
  doc.getElementById(TOOLBAR_STYLE_ID)?.remove();
}

function isPdf(reader: any): boolean {
  return Boolean(reader) && (reader._type === "pdf" || reader.type === "pdf");
}
