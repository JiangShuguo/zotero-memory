import { ADDON_ID } from "./constants";
import type { AnnotationType } from "./model/types";
import { PreferencePane } from "./prefs/pane";
import { ReaderSession } from "./reader/session";
import { TOOLBAR_CSS, TOOLBAR_STYLE_ID } from "./reader/styles";
import { logError, readSettings, writeEnabled, writeKind, type Settings } from "./settings";
import { NoteStore } from "./store";
import {
  addItemMenu,
  batchExportAnnotations,
  batchImportAnnotations,
  exportAnnotations,
  importAnnotations,
} from "./transfer/actions";
import { isLiveReader } from "./transfer/pdf-text";

const BUTTON_CLASS = "mem-toolbar-toggle";
const FALLBACK_SECTION_CLASS = "mem-fallback-section";
const FALLBACK_BUTTON_DELAY_MS = 350;

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
  /** One in-flight create/start per reader so toolbar + toggle cannot race. */
  private readonly sessionTasks = new Map<object, Promise<ReaderSession | undefined>>();
  private readonly pane = new PreferencePane({
    settings: () => this.settings,
    setKind: (kind, visible) => this.setKind(kind, visible),
    batchExportAnnotations: (ownerWindow) => void batchExportAnnotations(ownerWindow),
    batchImportAnnotations: (ownerWindow) => void this.batchImportAnnotations(ownerWindow),
  });
  private settings: Settings = readSettings();
  private notifierID?: string;
  private running = false;
  private readonly itemMenuCleanups: Array<() => void> = [];

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.settings = readSettings();
    await this.pane.register();
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
    for (const session of this.sessions.values()) {
      try {
        session.destroy();
      } catch (error) {
        logError(error);
      }
    }
    this.sessions.clear();
    this.sessionTasks.clear();
    this.pane.unregister();
    for (const reader of readers?._readers ?? []) removeToolbarButtons(reader?._iframeWindow?.document);
  }

  /** Called when a Zotero main window finishes loading. */
  onMainWindowLoad(win: Window): void {
    if (!this.running) return;
    this.bindItemMenu(win);
  }

  /** Called by the preference pane once it has loaded. */
  bindPreferences(win: Window): void {
    this.pane.bind(win);
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
      try {
        if (type === "item" && ["add", "modify", "delete", "trash"].includes(event)) this.refreshSessions();
        else this.dropClosedReaders();
      } catch (error) {
        logError(error);
      }
    },
  };

  private session(reader: any): Promise<ReaderSession | undefined> {
    if (!this.running || !isPdf(reader)) return Promise.resolve(undefined);
    const current = this.sessions.get(reader);
    if (current?.alive) {
      return current.start().then(
        () => current,
        (error) => {
          logError(error);
          return undefined;
        },
      );
    }
    const pending = this.sessionTasks.get(reader);
    if (pending) return pending;

    const task = this.openSession(reader);
    this.sessionTasks.set(reader, task);
    return task.finally(() => {
      if (this.sessionTasks.get(reader) === task) this.sessionTasks.delete(reader);
    });
  }

  private async openSession(reader: any): Promise<ReaderSession | undefined> {
    const existing = this.sessions.get(reader);
    if (existing?.alive) {
      try {
        await existing.start();
        return existing;
      } catch (error) {
        logError(error);
      }
    }
    if (existing) {
      existing.destroy();
      this.sessions.delete(reader);
    }

    const session = new ReaderSession(reader, this.store, this.settings);
    this.sessions.set(reader, session);
    try {
      await session.start();
      return session;
    } catch (error) {
      logError(error);
      if (this.sessions.get(reader) === session) this.sessions.delete(reader);
      session.destroy();
      return undefined;
    }
  }

  private refreshSessions(): void {
    this.eachSession((session) => session.refresh());
  }

  /** Runs `fn` on every live session; one broken session must not stop the others. */
  private eachSession(fn: (session: ReaderSession) => void): void {
    this.dropClosedReaders();
    for (const session of [...this.sessions.values()]) {
      if (!session.alive) continue;
      try {
        fn(session);
      } catch (error) {
        logError(error);
      }
    }
  }

  private async reveal(reader: any, keys: string[]): Promise<void> {
    if (!this.settings.enabled) this.setEnabled(true);
    const session = await this.session(reader);
    await session?.reveal(keys);
  }

  private importAnnotations(): Promise<void> {
    return importAnnotations(() => void this.afterImport());
  }

  private batchImportAnnotations(ownerWindow?: Window): Promise<void> {
    return batchImportAnnotations(() => void this.afterImport(), ownerWindow);
  }

  /** After import: turn Memory on and reload cards without tearing sessions down. */
  private afterImport(): void {
    if (!this.settings.enabled) this.setEnabled(true);
    else this.refreshSessions();
    void this.ensureOpenReaders();
  }

  private bindItemMenu(win: Window): void {
    const cleanup = addItemMenu(win, {
      export: () => void exportAnnotations(),
      import: () => void this.importAnnotations(),
    });
    if (cleanup) this.itemMenuCleanups.push(cleanup);
  }

  private setEnabled(enabled: boolean): void {
    writeEnabled(enabled);
    this.settings = { ...this.settings, enabled };
    this.syncButtons();
    this.pane.sync();
    this.eachSession((session) => session.setSettings(this.settings));
    if (enabled) void this.ensureOpenReaders();
  }

  private setKind(kind: AnnotationType, visible: boolean): void {
    if (this.settings.kinds.has(kind) === visible) return;
    const kinds = new Set(this.settings.kinds);
    if (visible) kinds.add(kind);
    else kinds.delete(kind);
    writeKind(kind, visible);
    this.settings = { ...this.settings, kinds };
    this.pane.sync();
    this.eachSession((session) => session.setSettings(this.settings));
  }

  /** Start sessions for open PDFs that do not have one yet, then refresh. */
  private async ensureOpenReaders(): Promise<void> {
    this.dropClosedReaders();
    for (const reader of (Zotero as any).Reader?._readers ?? []) {
      if (!isPdf(reader) || !isLiveReader(reader)) continue;
      try {
        const session = await this.session(reader);
        if (!session?.alive) continue;
        session.setSettings(this.settings);
        if (this.settings.enabled) session.refresh();
      } catch (error) {
        logError(error);
      }
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
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.setEnabled(!this.settings.enabled);
    });
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
      try {
        const doc = reader?._iframeWindow?.document as Document | undefined;
        doc?.querySelectorAll<HTMLButtonElement>(`.${BUTTON_CLASS}`).forEach((button) => this.syncButton(button));
      } catch {
        // Closed reader tab.
      }
    }
  }

  private syncButton(button: HTMLButtonElement): void {
    const enabled = this.settings.enabled;
    button.classList.toggle("active", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? "Memory is on. Click to hide the cards." : "Memory is off. Click to show the cards.";
    button.setAttribute("aria-label", button.title);
  }

  /** Forgets sessions whose reader tab is gone. Removes from the map first so a failing destroy cannot leave it behind. */
  private dropClosedReaders(): void {
    const live = new Set<object>(((Zotero as any).Reader?._readers ?? []).filter(isLiveReader));
    for (const [reader, session] of [...this.sessions]) {
      if (live.has(reader) && session.alive) continue;
      this.sessions.delete(reader);
      this.sessionTasks.delete(reader);
      try {
        session.destroy();
      } catch (error) {
        logError(error);
      }
    }
  }
}

function removeToolbarButtons(doc: Document | undefined): void {
  if (!doc) return;
  doc.querySelectorAll(`.${BUTTON_CLASS}, .${FALLBACK_SECTION_CLASS}`).forEach((node) => node.remove());
  doc.getElementById(TOOLBAR_STYLE_ID)?.remove();
}

function isPdf(reader: any): boolean {
  return Boolean(reader) && (reader._type === "pdf" || reader.type === "pdf");
}
