import { anchorOnPage, noteShouldShow } from "../model/anchor";
import type { MarginNote, PageAnchor } from "../model/types";
import { logError, type Settings } from "../settings";
import type { NoteStore } from "../store";
import { PdfBridge, type PdfPage } from "./bridge";
import { Card, type CardHost } from "./card";
import { PageOverlay, type OverlayHost } from "./page-overlay";
import { SURFACE_CSS, SURFACE_STYLE_ID } from "./styles";
import {
  UndoHistory,
  captureAnnotationSnapshot,
  type AnnotationSnapshot,
  type UndoEntry,
} from "./undo";

const ROOT_CLASS = "mem-overlay-root";
const VIEWER_CLASS = "mem-viewer";
const SETTLE_FRAMES = 4;
const VISIBILITY_SETTLE_MS = 80;

/** Memory inside one open PDF reader tab. */
export class ReaderSession {
  private readonly bridge: PdfBridge;
  private readonly cards = new Map<string, Card>();
  private readonly overlays = new Map<number, PageOverlay>();
  private readonly pinned = new Set<string>();
  private readonly pendingLayout = new Set<PageOverlay>();
  private notes: MarginNote[] = [];
  /** Explicitly hidden native annotations; see PdfBridge.hiddenIDs(). */
  private nativeHidden?: ReadonlySet<string> | "all";
  /** Keys once observed in the reader; used to drop cards the instant the reader deletes them. */
  private readonly seenInReader = new Set<string>();
  /** Latest key set from the reader, or undefined when the reader state is unavailable. */
  private readerKeys?: ReadonlySet<string>;
  private root?: HTMLElement;
  private cardDocument?: Document;
  private activeKey?: string;
  private hoveredKey?: string;
  private ready = false;
  private destroyed = false;
  private startup?: Promise<void>;
  private cancelFrame?: () => void;
  private framesLeft = 0;
  private recenterLeft = 0;
  private forcePaint = false;
  private lastGeometry = "";
  private layoutQueued = false;
  private visibilityTimer?: ReturnType<typeof setTimeout>;
  private popupPending?: string[];
  /** Annotations whose native popup is open and that did not yet have a margin card. */
  private readonly holdForPopup = new Set<string>();

  private readonly history = new UndoHistory();
  /** Latest sync snapshots so a reader delete can still be undone. */
  private readonly snapshots = new Map<string, AnnotationSnapshot>();
  private unbindHistoryKeys?: () => void;

  private readonly cardHost: CardHost = {
    save: async (card, value) => {
      await this.store.saveComment(card.note.itemID, value);
      if (value.trim()) this.pinned.delete(card.key);
      this.rememberSnapshot(card.key, card.note.itemID);
    },
    setColor: async (card, color) => {
      await this.store.saveColor(card.note.itemID, color);
      // Notifier refresh redraws the PDF highlight; also refresh lines now for the new border color.
      this.queueLayout(card);
      this.rememberSnapshot(card.key, card.note.itemID);
    },
    recordComment: (card, before, after) => {
      this.history.push({
        kind: "comment",
        key: card.key,
        itemID: card.note.itemID,
        before,
        after,
      });
    },
    recordColor: (card, before, after) => {
      this.history.push({
        kind: "color",
        key: card.key,
        itemID: card.note.itemID,
        before,
        after,
      });
    },
    undo: () => this.undo(),
    redo: () => this.redo(),
    discardCommentDrafts: (card, persisted) => this.history.discardCommentDrafts(card.key, persisted),
    copyText: (text) => copyToClipboard(text),
    activate: (card) => {
      this.setActive(card.key);
      this.bridge.select(card.key);
    },
    highlight: (card) => this.setActive(card.key),
    hover: (card, hovered) => {
      if (hovered) this.setHover(card.key);
      else if (this.hoveredKey === card.key) this.setHover(undefined);
    },
    resized: (card) => this.queueLayout(card),
    editingChanged: (card) => {
      this.queueLayout(card);
      if (!card.isEditing) this.schedulePaint(true, 1);
    },
  };

  private readonly overlayHost: OverlayHost = {
    hoveredKey: () => this.hoveredKey,
  };

  constructor(
    readonly reader: any,
    private readonly store: NoteStore,
    private settings: Settings,
  ) {
    this.bridge = new PdfBridge(reader);
  }

  get alive(): boolean {
    return !this.destroyed;
  }

  start(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("Memory: reader session was destroyed"));
    this.startup ??= this.boot();
    return this.startup;
  }

  setSettings(settings: Settings): void {
    this.settings = settings;
    if (!this.ready || this.destroyed) return;
    this.paint();
  }

  refresh(): void {
    if (!this.ready || this.destroyed) return;
    const attachmentID = this.attachmentID();
    if (!attachmentID) return;
    this.notes = this.store.list(attachmentID);
    if (!this.history.isApplying) this.refreshSnapshots(this.notes);
    // Fresh notes should not stay trapped behind a native-popup hold.
    this.holdForPopup.clear();
    this.paint();
  }

  /** Shows the given annotations even without a comment, and opens the first one for editing. */
  async reveal(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.pinned.add(String(key));
    await this.start();
    this.refresh();
    const first = keys[0];
    if (first === undefined) return;
    this.setActive(String(first));
    setTimeout(() => this.cards.get(String(first))?.open(true), 0);
  }

  /** Never throws: the reader window may already be a dead object. */
  destroy(): void {
    this.destroyed = true;
    this.ready = false;
    this.history.clear();
    this.snapshots.clear();
    attempt(() => this.unbindHistoryKeys?.());
    this.unbindHistoryKeys = undefined;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    attempt(() => this.cancelFrame?.());
    this.cancelFrame = undefined;
    attempt(() => this.clearUi());
    attempt(() => this.bridge.destroy());
  }

  async undo(): Promise<void> {
    if (this.destroyed || !this.history.canUndo) return;
    await this.history.undo((entry, toward) => this.applyHistory(entry, toward));
  }

  async redo(): Promise<void> {
    if (this.destroyed || !this.history.canRedo) return;
    await this.history.redo((entry, toward) => this.applyHistory(entry, toward));
  }

  // -------------------------------------------------------------------------

  private async boot(): Promise<void> {
    await this.bridge.ready();
    if (this.destroyed) {
      this.bridge.destroy();
      return;
    }
    this.ready = true;
    this.applyReaderVisibility(false);
    this.bridge.onGeometryChange((reason) => {
      if (reason === "scalechanging") this.recenterLeft = SETTLE_FRAMES;
      this.schedulePaint(false);
    });
    this.bridge.onAnnotationVisibility(() => this.scheduleVisibility());
    this.bridge.onSelection((ids) => {
      if (ids.length === 1) this.setActive(ids[0]!);
      this.syncPopup(ids);
    });
    this.bridge.onAnnotationPopup((ids) => this.syncPopupHold(ids));
    this.bindHistoryKeys();
    this.refresh();
    this.syncPopupHold(this.bridge.annotationPopupIDs());
  }

  private bindHistoryKeys(): void {
    const doc = this.bridge.document();
    if (!doc) return;
    attempt(() => this.unbindHistoryKeys?.());
    const onKey = (event: KeyboardEvent) => {
      if (this.destroyed) return;
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        if (!this.history.canUndo) return;
        event.preventDefault();
        event.stopPropagation();
        void this.undo();
        return;
      }
      if (key === "y" || (key === "z" && event.shiftKey)) {
        if (!this.history.canRedo) return;
        event.preventDefault();
        event.stopPropagation();
        void this.redo();
      }
    };
    doc.addEventListener("keydown", onKey, true);
    this.unbindHistoryKeys = () => doc.removeEventListener("keydown", onKey, true);
  }

  private attachmentID(): number | undefined {
    const id = Math.trunc(Number(this.reader?.itemID));
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }

  private rememberSnapshot(key: string, itemID: number): void {
    try {
      const item = (Zotero as any).Items.get(itemID);
      const snap = captureAnnotationSnapshot(item);
      if (snap) this.snapshots.set(key, snap);
    } catch {
      // Item may already be gone.
    }
  }

  private refreshSnapshots(notes: readonly MarginNote[]): void {
    const live = new Set(notes.map((note) => note.key));
    for (const key of [...this.snapshots.keys()]) {
      if (!live.has(key)) this.snapshots.delete(key);
    }
    for (const note of notes) this.rememberSnapshot(note.key, note.itemID);
  }

  private noteRemovedDeletes(previousKeys: ReadonlySet<string> | undefined, nextKeys: ReadonlySet<string> | undefined): void {
    if (this.history.isApplying || !previousKeys || !nextKeys) return;
    const attachmentID = this.attachmentID();
    if (!attachmentID) return;
    for (const key of previousKeys) {
      if (nextKeys.has(key)) continue;
      const snapshot = this.snapshots.get(key);
      if (!snapshot) continue;
      this.history.push({ kind: "delete", attachmentID, key, snapshot: structuredCloneSafe(snapshot) });
      this.snapshots.delete(key);
    }
  }

  private async applyHistory(entry: UndoEntry, toward: "before" | "after"): Promise<void> {
    try {
      if (entry.kind === "comment") {
        const value = toward === "before" ? entry.before : entry.after;
        await this.store.saveComment(entry.itemID, value);
        if (value.trim()) this.pinned.delete(entry.key);
        const card = this.cards.get(entry.key);
        if (card) card.forceComment(value, { persisted: true });
        this.rememberSnapshot(entry.key, entry.itemID);
        this.refresh();
        return;
      }
      if (entry.kind === "color") {
        const value = toward === "before" ? entry.before : entry.after;
        await this.store.saveColor(entry.itemID, value);
        const card = this.cards.get(entry.key);
        if (card) card.forceColor(value);
        this.rememberSnapshot(entry.key, entry.itemID);
        this.refresh();
        return;
      }
      // delete: toward before = restore annotation; toward after = delete again
      if (toward === "before") await this.restoreDeleted(entry);
      else await this.deleteRestored(entry);
    } catch (error) {
      logError(error);
    }
  }

  private async restoreDeleted(entry: Extract<UndoEntry, { kind: "delete" }>): Promise<void> {
    const attachment = (Zotero as any).Items.get(entry.attachmentID);
    if (!attachment?.isPDFAttachment?.()) throw new Error("PDF attachment is missing");
    const payload = { ...entry.snapshot };
    if (!payload.key) payload.key = entry.key;
    const item = await (Zotero as any).Annotations.saveFromJSON(attachment, payload);
    const key = String(item?.key ?? payload.key ?? entry.key);
    const itemID = Number(item?.id ?? 0);
    if (itemID) this.rememberSnapshot(key, itemID);
    // Keep empty restored comments visible until the user edits again.
    if (!String(payload.comment ?? "").trim()) this.pinned.add(key);
    this.refresh();
  }

  private async deleteRestored(entry: Extract<UndoEntry, { kind: "delete" }>): Promise<void> {
    const attachment = (Zotero as any).Items.get(entry.attachmentID);
    const annotations: any[] = attachment?.getAnnotations?.(false) ?? [];
    const wantKey = String(entry.snapshot.key ?? entry.key);
    const item = annotations.find((ann) => String(ann.key) === wantKey);
    if (!item) return;
    this.rememberSnapshot(wantKey, Number(item.id));
    await item.eraseTx?.();
    this.snapshots.delete(wantKey);
    this.pinned.delete(wantKey);
    this.refresh();
  }

  private paint(): void {
    if (!this.ready || this.destroyed) return;
    const doc = this.bridge.document();
    const viewer = this.bridge.viewerElement();
    if (!doc || !viewer) return;
    if (!this.settings.enabled) {
      this.clearUi();
      return;
    }
    if (this.cardDocument && this.cardDocument !== doc) this.clearUi();
    this.cardDocument = doc;
    ensureStyle(doc);

    const shown = this.notes.filter((note) => {
      if (this.cards.get(note.key)?.busy) return true;
      if (this.holdForPopup.has(note.key)) return false;
      // Reader already dropped it (delete) but the DB notifier has not caught up yet.
      if (this.readerKeys && this.seenInReader.has(note.key) && !this.readerKeys.has(note.key)) return false;
      return this.settings.kinds.has(note.type) && noteShouldShow(note, this.pinned);
    });
    this.syncCards(doc, shown);
    viewer.classList.toggle(VIEWER_CLASS, shown.length > 0);
    if (!shown.length) {
      this.removeOverlays();
      this.lastGeometry = this.geometryKey();
      return;
    }

    const root = this.ensureRoot(doc, viewer);
    const byPage = new Map<number, MarginNote[]>();
    for (const note of shown) {
      const list = byPage.get(note.position.pageIndex);
      if (list) list.push(note);
      else byPage.set(note.position.pageIndex, [note]);
    }
    for (const [pageIndex, overlay] of this.overlays) {
      if (byPage.has(pageIndex)) continue;
      overlay.destroy();
      this.overlays.delete(pageIndex);
    }

    let waiting = false;
    for (const [pageIndex, notes] of byPage) {
      const page = this.bridge.page(pageIndex);
      if (!page) {
        if (pageIndex < this.bridge.pageCount()) waiting = true;
        continue;
      }
      let overlay = this.overlays.get(pageIndex);
      if (!overlay) {
        overlay = new PageOverlay(doc, page, this.overlayHost);
        this.overlays.set(pageIndex, overlay);
      }
      overlay.attach(root, page);
      const cards: Card[] = [];
      for (const note of notes) {
        const card = this.cards.get(note.key);
        if (!card) continue;
        card.anchor = this.anchorFor(note, page, overlay);
        if (card.anchor) cards.push(card);
      }
      overlay.setCards(cards);
      overlay.layout();
    }
    this.lastGeometry = this.geometryKey();
    this.syncActive();
    if (this.popupPending) this.recheckPopup();
    if (waiting) this.schedulePaint(true, 1);
  }

  /** Keeps exactly one card per shown annotation, reusing existing cards. */
  private syncCards(doc: Document, shown: readonly MarginNote[]): void {
    const keep = new Set(shown.map((note) => note.key));
    for (const [key, card] of this.cards) {
      if (keep.has(key)) continue;
      card.destroy();
      this.cards.delete(key);
    }
    for (const note of shown) {
      let card = this.cards.get(note.key);
      if (card) {
        card.update(note);
      } else {
        card = new Card(doc, note, this.cardHost);
        card.element.classList.toggle("mem-hovered", this.hoveredKey === note.key);
        this.cards.set(note.key, card);
      }
      const hidden =
        this.nativeHidden === "all" ||
        (this.nativeHidden !== undefined && this.nativeHidden.has(note.key));
      card.element.classList.toggle("mem-filtered", hidden && !card.isEditing);
    }
  }

  private anchorFor(note: MarginNote, page: PdfPage, overlay: PageOverlay): PageAnchor | undefined {
    const anchor = anchorOnPage(note.position, page.viewport);
    if (!anchor) return undefined;
    const { width, height } = overlay.size();
    const scaleX = page.viewport.width > 0 ? width / page.viewport.width : 1;
    const scaleY = page.viewport.height > 0 ? height / page.viewport.height : 1;
    return {
      x: clamp(anchor.x * scaleX, 0, width),
      y: clamp(anchor.y * scaleY, 0, height),
      side: anchor.side,
    };
  }

  private schedulePaint(force: boolean, frames = SETTLE_FRAMES): void {
    if (!this.ready || this.destroyed || !this.settings.enabled) return;
    if (force) this.forcePaint = true;
    this.framesLeft = Math.max(this.framesLeft, frames);
    if (this.cancelFrame) return;
    this.cancelFrame = this.bridge.frame(() => {
      this.cancelFrame = undefined;
      try {
        if (this.forcePaint || this.geometryKey() !== this.lastGeometry) {
          this.forcePaint = false;
          this.paint();
        }
        if (this.recenterLeft > 0) {
          this.recenterLeft -= 1;
          this.bridge.recenterCurrentPage();
        }
      } catch (error) {
        logError(error);
      }
      this.framesLeft = Math.max(0, this.framesLeft - 1);
      if (this.framesLeft > 0) this.schedulePaint(false, 0);
    });
  }

  /** A cheap fingerprint of everything the overlay positions depend on. */
  private geometryKey(): string {
    const viewer = this.bridge.viewerElement();
    const parts = [String(viewer?.clientWidth ?? 0), String(viewer?.clientHeight ?? 0)];
    for (const pageIndex of this.overlays.keys()) {
      const page = this.bridge.page(pageIndex);
      if (!page) {
        parts.push(`${pageIndex}:-`);
        continue;
      }
      const element = page.element;
      parts.push(
        `${pageIndex}:${element.offsetLeft},${element.offsetTop},${element.clientWidth},${element.clientHeight},${page.scale}`,
      );
    }
    return parts.join("|");
  }

  private queueLayout(card: Card): void {
    const overlay = this.overlays.get(card.note.position.pageIndex);
    if (!overlay) return;
    this.pendingLayout.add(overlay);
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    void Promise.resolve().then(() => {
      this.layoutQueued = false;
      const overlays = [...this.pendingLayout];
      this.pendingLayout.clear();
      for (const pending of overlays) {
        if (this.overlays.get(pending.pageIndex) === pending) pending.layout();
      }
    });
  }

  private scheduleVisibility(): void {
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    // Deletions should clear the card immediately; filter toggles can settle briefly.
    const keys = this.bridge.annotationKeys();
    const removed =
      Boolean(keys) &&
      [...this.seenInReader].some((key) => keys && !keys.has(key) && this.cards.has(key));
    if (removed) {
      this.applyReaderVisibility(true);
      return;
    }
    this.visibilityTimer = setTimeout(() => {
      this.visibilityTimer = undefined;
      if (!this.ready || this.destroyed) return;
      this.applyReaderVisibility(true);
    }, VISIBILITY_SETTLE_MS);
  }

  private applyReaderVisibility(paint: boolean): void {
    this.nativeHidden = this.bridge.hiddenIDs();
    const keys = this.bridge.annotationKeys();
    this.noteRemovedDeletes(this.readerKeys, keys);
    this.readerKeys = keys;
    if (keys) {
      for (const key of keys) this.seenInReader.add(key);
    }
    if (paint) this.paint();
  }

  /**
   * While the native popup is open for a brand-new empty annotation, keep the margin card
   * hidden so the user finishes writing in one place. Annotations that already have a
   * comment always keep their cards — holding those made imports look like a total outage.
   */
  private syncPopupHold(ids: readonly string[]): void {
    const open = new Set(ids);
    let changed = false;
    for (const key of [...this.holdForPopup]) {
      if (open.has(key)) continue;
      this.holdForPopup.delete(key);
      changed = true;
    }
    for (const id of open) {
      if (this.holdForPopup.has(id)) continue;
      const card = this.cards.get(id);
      if (card && card.element.getClientRects().length > 0) continue;
      const note = this.notes.find((entry) => entry.key === id);
      // Already has a comment (or is a note annotation): never hold it back.
      if (note && (note.type === "note" || note.comment.trim())) continue;
      this.holdForPopup.add(id);
      changed = true;
    }
    if (changed) this.paint();
    this.syncPopup(this.bridge.selectedIDs());
  }

  /**
   * Hides the reader's popup only when every selected annotation already has a visible card.
   * Runs on selection changes alone, so a popup the user is typing into never disappears.
   */
  private syncPopup(ids: readonly string[]): void {
    const hasCards =
      this.settings.enabled &&
      ids.length > 0 &&
      ids.every((id) => {
        if (this.holdForPopup.has(id)) return false;
        return this.cards.has(id);
      });
    // A card may exist before its page is laid out (e.g. after a sidebar jump); retry after paint.
    this.popupPending = hasCards ? [...ids] : undefined;
    this.recheckPopup();
  }

  private recheckPopup(): void {
    const ids = this.popupPending;
    if (!ids) {
      this.bridge.setAnnotationPopupHidden(false);
      return;
    }
    const visible = ids.every((id) => {
      const card = this.cards.get(id);
      return Boolean(card && card.element.getClientRects().length > 0);
    });
    this.bridge.setAnnotationPopupHidden(visible);
    if (visible || !ids.every((id) => this.cards.has(id))) this.popupPending = undefined;
  }

  private setActive(key: string): void {
    this.activeKey = key;
    this.syncActive();
    const card = this.cards.get(key);
    if (card) this.overlays.get(card.note.position.pageIndex)?.reveal(key);
  }

  private syncActive(): void {
    for (const card of this.cards.values()) {
      card.element.classList.toggle("mem-active", card.key === this.activeKey);
    }
  }

  private setHover(key: string | undefined): void {
    if (this.hoveredKey === key) return;
    this.hoveredKey = key;
    this.bridge.hoverAnnotation(key);
    for (const card of this.cards.values()) card.element.classList.toggle("mem-hovered", card.key === key);
    for (const overlay of this.overlays.values()) overlay.setHovered(key);
  }

  /** One overlay root per document; roots left behind by an earlier instance are removed. */
  private ensureRoot(doc: Document, viewer: HTMLElement): HTMLElement {
    const host = viewer.closest<HTMLElement>("#viewerContainer") ?? viewer.parentElement ?? viewer;
    if (!this.root || this.root.ownerDocument !== doc) {
      this.root = doc.createElement("div");
      this.root.className = ROOT_CLASS;
    }
    for (const stale of Array.from(doc.querySelectorAll(`.${ROOT_CLASS}`)) as Element[]) {
      if (stale !== this.root) stale.remove();
    }
    if (this.root.parentElement !== host) host.append(this.root);
    return this.root;
  }

  private removeOverlays(): void {
    for (const overlay of this.overlays.values()) overlay.destroy();
    this.overlays.clear();
    this.pendingLayout.clear();
    this.root?.remove();
    this.root = undefined;
  }

  private clearUi(): void {
    for (const card of this.cards.values()) attempt(() => card.destroy());
    this.cards.clear();
    for (const overlay of this.overlays.values()) attempt(() => overlay.destroy());
    this.overlays.clear();
    this.pendingLayout.clear();
    attempt(() => this.root?.remove());
    this.root = undefined;
    attempt(() => this.setHover(undefined));
    this.hoveredKey = undefined;
    this.popupPending = undefined;
    this.holdForPopup.clear();
    this.seenInReader.clear();
    this.readerKeys = undefined;
    this.nativeHidden = undefined;
    attempt(() => this.bridge.setAnnotationPopupHidden(false));
    const doc = this.cardDocument ?? this.bridge.document();
    try {
      this.bridge.viewerElement()?.classList.remove(VIEWER_CLASS);
      doc?.getElementById(SURFACE_STYLE_ID)?.remove();
      doc?.querySelectorAll(`.${ROOT_CLASS}`).forEach((node) => node.remove());
    } catch {
      // The reader can close before the overlay does.
    }
    this.cardDocument = undefined;
  }
}

function attempt(run: () => void): void {
  try {
    run();
  } catch {
    // Dead reader windows throw on any access; cleanup must still finish.
  }
}

function ensureStyle(doc: Document): void {
  let style = doc.getElementById(SURFACE_STYLE_ID);
  if (!style) {
    style = doc.createElement("style");
    style.id = SURFACE_STYLE_ID;
    (doc.head ?? doc.documentElement).append(style);
  }
  if (style.textContent !== SURFACE_CSS) style.textContent = SURFACE_CSS;
}

function copyToClipboard(text: string): void {
  try {
    (Zotero as any).Utilities.Internal.copyTextToClipboard(text);
  } catch (error) {
    logError(error);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
