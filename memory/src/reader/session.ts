import { anchorOnPage, compactNoteAnchor, noteShouldShow } from "../model/anchor";
import type { MarginNote, MarginSide, PageAnchor } from "../model/types";
import { logError, type Settings } from "../settings";
import type { NoteStore } from "../store";
import { PdfBridge, type PdfPage } from "./bridge";
import { Card, type CardHost } from "./card";
import { PageOverlay, type OverlayHost } from "./page-overlay";
import { SURFACE_CSS, SURFACE_STYLE_ID } from "./styles";

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
  private readonly openColumns = new Set<string>();
  private readonly pendingLayout = new Set<PageOverlay>();
  private notes: MarginNote[] = [];
  private nativeVisible?: ReadonlySet<string>;
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

  private readonly cardHost: CardHost = {
    save: async (card, value) => {
      await this.store.saveComment(card.note.itemID, value);
      if (value.trim()) this.pinned.delete(card.key);
    },
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
    isColumnOpen: (pageIndex, side) => this.openColumns.has(columnKey(pageIndex, side)),
    setColumnOpen: (pageIndex, side, open) => {
      if (open) this.openColumns.add(columnKey(pageIndex, side));
      else this.openColumns.delete(columnKey(pageIndex, side));
    },
    hoveredKey: () => this.hoveredKey,
  };

  constructor(
    readonly reader: any,
    private readonly store: NoteStore,
    private settings: Settings,
  ) {
    this.bridge = new PdfBridge(reader);
  }

  start(): Promise<void> {
    this.startup ??= this.boot();
    return this.startup;
  }

  setSettings(settings: Settings): void {
    const compactChanged = settings.compactNotes !== this.settings.compactNotes;
    this.settings = settings;
    if (!this.ready) return;
    if (compactChanged) this.bridge.setCompactNotes(settings.compactNotes);
    this.paint();
  }

  refresh(): void {
    if (!this.ready || this.destroyed) return;
    const attachmentID = Number(this.reader?.itemID);
    if (!Number.isInteger(attachmentID)) return;
    this.notes = this.store.list(attachmentID);
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

  destroy(): void {
    this.destroyed = true;
    this.ready = false;
    this.cancelFrame?.();
    this.cancelFrame = undefined;
    if (this.visibilityTimer) clearTimeout(this.visibilityTimer);
    this.clearUi();
    this.bridge.destroy();
  }

  // -------------------------------------------------------------------------

  private async boot(): Promise<void> {
    await this.bridge.ready();
    if (this.destroyed) {
      this.bridge.destroy();
      return;
    }
    this.ready = true;
    this.nativeVisible = this.bridge.visibleIDs();
    this.bridge.onGeometryChange((reason) => {
      if (reason === "scalechanging") this.recenterLeft = SETTLE_FRAMES;
      this.schedulePaint(false);
    });
    this.bridge.onAnnotationVisibility(() => this.scheduleVisibility());
    this.bridge.onSelection((ids) => {
      if (ids.length === 1) this.setActive(ids[0]!);
      this.syncPopup(ids);
    });
    if (this.settings.compactNotes) this.bridge.setCompactNotes(true);
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

    const shown = this.notes.filter(
      (note) =>
        this.cards.get(note.key)?.busy ||
        (this.settings.kinds.has(note.type) && noteShouldShow(note, this.pinned)),
    );
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
      const hidden = this.nativeVisible !== undefined && !this.nativeVisible.has(note.key);
      card.element.classList.toggle("mem-filtered", hidden && !card.isEditing);
    }
  }

  private anchorFor(note: MarginNote, page: PdfPage, overlay: PageOverlay): PageAnchor | undefined {
    const anchor =
      this.settings.compactNotes && note.type === "note"
        ? compactNoteAnchor(note.position, page.viewport)
        : anchorOnPage(note.position, page.viewport);
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
    this.visibilityTimer = setTimeout(() => {
      this.visibilityTimer = undefined;
      if (!this.ready || this.destroyed) return;
      this.nativeVisible = this.bridge.visibleIDs();
      this.schedulePaint(true, 1);
    }, VISIBILITY_SETTLE_MS);
  }

  /**
   * Hides the reader's popup only when every selected annotation already has a visible card.
   * Runs on selection changes alone, so a popup the user is typing into never disappears.
   */
  private syncPopup(ids: readonly string[]): void {
    const hasCards = this.settings.enabled && ids.length > 0 && ids.every((id) => this.cards.has(id));
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
    for (const card of this.cards.values()) card.destroy();
    this.cards.clear();
    this.removeOverlays();
    this.setHover(undefined);
    this.popupPending = undefined;
    this.bridge.setAnnotationPopupHidden(false);
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

function columnKey(pageIndex: number, side: MarginSide): string {
  return `${pageIndex}:${side}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
