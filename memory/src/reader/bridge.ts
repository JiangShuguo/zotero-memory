import { logError } from "../settings";
import type { ViewportBox } from "../model/types";
import { NATIVE_HOVER_CSS, NATIVE_HOVER_STYLE_ID } from "./styles";

export interface PdfPage {
  pageIndex: number;
  element: HTMLElement;
  viewport: ViewportBox;
  scale: number;
}

type Cleanup = () => void;
type AnyRecord = Record<string, any>;

const READY_TIMEOUT_MS = 10000;
const VISIBILITY_POLL_MS = 250;
const POPUP_STYLE_ID = "mem-hide-popup-style";
const POPUP_HIDDEN_CLASS = "mem-hide-annotation-popup";
const HIDE_POPUP_CSS = `:root.${POPUP_HIDDEN_CLASS} .view-popup.annotation-popup { display: none !important; }`;

/** Everything Memory needs from the Zotero PDF reader, kept behind one small interface. */
export class PdfBridge {
  private pdfWindow?: Window & AnyRecord;
  private pdfDocument?: Document;
  private pdfViewer?: AnyRecord;
  private internalReader?: AnyRecord;
  private primaryView?: AnyRecord;
  private readonly cleanups: Cleanup[] = [];
  private hoveredNodes: Element[] = [];
  private stateHooked = false;
  private readonly selectionCallbacks: Array<(ids: string[]) => void> = [];
  private readonly popupCallbacks: Array<(ids: string[]) => void> = [];
  private readonly visibilityCallbacks: Array<() => void> = [];

  constructor(private readonly reader: AnyRecord) {}

  async ready(): Promise<void> {
    await settle(this.reader?._initPromise);
    const started = Date.now();
    while (!this.primaryView && Date.now() - started < READY_TIMEOUT_MS) {
      this.internalReader = this.reader?._internalReader;
      this.primaryView = this.internalReader?._primaryView;
      if (!this.primaryView) await wait(30);
    }
    if (!this.primaryView) throw new Error("Memory: the PDF view did not appear");
    await settle(this.primaryView.initializedPromise);
    this.pdfWindow = this.primaryView._iframeWindow;
    this.pdfDocument = this.primaryView._iframeDocument ?? this.pdfWindow?.document;
    const application = this.pdfWindow?.PDFViewerApplication;
    await settle(application?.initializedPromise);
    this.pdfViewer = application?.pdfViewer;
    await settle(this.pdfViewer?.pagesPromise);
    if (!this.pdfDocument || !this.pdfViewer) throw new Error("Memory: the PDF view is not ready");
  }

  document(): Document | undefined {
    return this.pdfDocument;
  }

  viewerElement(): HTMLElement | undefined {
    return (this.pdfDocument?.getElementById("viewer") as HTMLElement | null) ?? undefined;
  }

  page(pageIndex: number): PdfPage | undefined {
    const pageView = this.pdfViewer?.getPageView?.(pageIndex);
    const element = pageView?.div as HTMLElement | undefined;
    const viewport = pageView?.viewport as ViewportBox | undefined;
    if (!element || !viewport) return undefined;
    const scale = Number(this.pdfViewer?.currentScale ?? pageView?.scale ?? 1);
    return { pageIndex, element, viewport, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
  }

  pageCount(): number {
    return Number(this.pdfViewer?.pagesCount ?? this.pdfViewer?._pages?.length ?? 0);
  }

  onGeometryChange(callback: (reason: string) => void): void {
    const bus = this.pdfWindow?.PDFViewerApplication?.eventBus;
    for (const name of ["pagerendered", "scalechanging", "rotationchanging", "updateviewarea", "pagesloaded"]) {
      const run = () => callback(name);
      bus?.on?.(name, run);
      this.cleanups.push(() => bus?.off?.(name, run));
    }
    const onResize = () => callback("resize");
    const pdfWindow = this.pdfWindow;
    pdfWindow?.addEventListener("resize", onResize);
    this.cleanups.push(() => pdfWindow?.removeEventListener("resize", onResize));
  }

  /** Calls back when the reader's own annotation filter (sidebar search, hide all) changes. */
  onAnnotationVisibility(callback: () => void): void {
    this.visibilityCallbacks.push(callback);
    this.ensureStateHook();
  }

  onSelection(callback: (ids: string[]) => void): void {
    this.selectionCallbacks.push(callback);
    this.ensureStateHook();
    const doc = this.pdfDocument;
    const pdfWindow = this.pdfWindow;
    if (!doc || !pdfWindow) return;
    const run = () => pdfWindow.setTimeout(() => callback(this.selectedIDs()), 0);
    doc.addEventListener("pointerup", run, true);
    doc.addEventListener("keyup", run, true);
    this.cleanups.push(() => {
      doc.removeEventListener("pointerup", run, true);
      doc.removeEventListener("keyup", run, true);
    });
  }

  /** Fires when the reader's built-in annotation popup opens or closes. */
  onAnnotationPopup(callback: (ids: string[]) => void): void {
    this.popupCallbacks.push(callback);
    this.ensureStateHook();
  }

  /** Annotation IDs currently shown in the reader's annotation popup, if any. */
  annotationPopupIDs(): string[] {
    return popupIDsFromState(this.internalReader?._state);
  }

  selectedIDs(): string[] {
    const ids = this.internalReader?._state?.selectedAnnotationIDs;
    return Array.isArray(ids) ? ids.map(String) : [];
  }

  /**
   * Annotation keys the reader has explicitly hidden.
   * - `undefined`: reader state unavailable — do not filter Memory cards
   * - `"all"`: annotations are globally hidden in the reader
   * - `Set`: only these keys are hidden (`_hidden`); keys missing from the reader
   *   state (e.g. just imported) stay visible so cards are not blanked out
   */
  hiddenIDs(): ReadonlySet<string> | "all" | undefined {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return undefined;
    if (state?.showAnnotations === false) return "all";
    const hidden = new Set<string>();
    for (const annotation of annotations) {
      if (!annotation?._hidden) continue;
      const id = annotation.id ?? annotation.key;
      if (id !== undefined && id !== null) hidden.add(String(id));
    }
    return hidden;
  }

  /** Every annotation key currently in the reader state, or undefined if unavailable. */
  annotationKeys(): ReadonlySet<string> | undefined {
    const annotations = this.internalReader?._state?.annotations;
    if (!Array.isArray(annotations)) return undefined;
    const keys = new Set<string>();
    for (const annotation of annotations) {
      const id = annotation?.id ?? annotation?.key;
      if (id !== undefined && id !== null) keys.add(String(id));
    }
    return keys;
  }

  select(key: string): void {
    this.internalReader?.setSelectedAnnotations?.([key]);
    void this.reader?.navigate?.({ annotationID: key });
  }

  recenterCurrentPage(): void {
    const viewer = this.viewerElement();
    const scroller = viewer?.closest<HTMLElement>("#viewerContainer") ?? viewer?.parentElement;
    const current = Math.max(0, Number(this.pdfViewer?.currentPageNumber ?? 1) - 1);
    const page = this.page(current)?.element;
    if (!scroller || !page) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const width = scroller.clientWidth || scrollerRect.width;
    if (!(pageRect.width || pageRect.height) || !(width > 0)) return;
    const delta = pageRect.left + pageRect.width / 2 - (scrollerRect.left + scroller.clientLeft + width / 2);
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) scroller.scrollLeft += delta;
  }

  hoverAnnotation(key: string | undefined): void {
    for (const node of this.hoveredNodes) node.classList.remove("mem-native-hover");
    this.hoveredNodes = [];
    if (!key) return;
    this.ensureHoverStyle();
    this.hoveredNodes = this.annotationNodes(key);
    for (const node of this.hoveredNodes) node.classList.add("mem-native-hover");
  }

  /** Hides the reader's own annotation popup, whose comment the margin card already shows. */
  setAnnotationPopupHidden(hidden: boolean): void {
    const doc = this.readerDocument();
    const root = doc?.documentElement;
    if (!doc || !root) return;
    if (hidden && !doc.getElementById(POPUP_STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = POPUP_STYLE_ID;
      style.textContent = HIDE_POPUP_CSS;
      (doc.head ?? root).append(style);
    }
    root.classList.toggle(POPUP_HIDDEN_CLASS, hidden);
  }

  frame(callback: () => void): Cleanup {
    const pdfWindow = this.pdfWindow;
    if (pdfWindow && typeof pdfWindow.requestAnimationFrame === "function") {
      const id = pdfWindow.requestAnimationFrame(callback);
      return () => pdfWindow.cancelAnimationFrame(id);
    }
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  }

  destroy(): void {
    this.hoverAnnotation(undefined);
    this.shadowRoot()?.getElementById(NATIVE_HOVER_STYLE_ID)?.remove();
    const readerDoc = this.readerDocument();
    readerDoc?.documentElement?.classList.remove(POPUP_HIDDEN_CLASS);
    readerDoc?.getElementById(POPUP_STYLE_ID)?.remove();
    this.selectionCallbacks.length = 0;
    this.popupCallbacks.length = 0;
    this.visibilityCallbacks.length = 0;
    this.stateHooked = false;
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // The reader window may already be gone.
      }
    }
    this.pdfViewer = undefined;
    this.pdfDocument = undefined;
    this.pdfWindow = undefined;
    this.primaryView = undefined;
    this.internalReader = undefined;
  }

  private annotationNodes(key: string): Element[] {
    const shadow = this.shadowRoot();
    const roots = [
      this.primaryView?._annotationRenderRootEl ?? shadow?.getElementById("annotation-render-root"),
      shadow,
      this.pdfDocument,
    ].filter((root): root is ParentNode => Boolean(root && "querySelectorAll" in root));
    const matches = new Set<Element>();
    for (const root of roots) {
      for (const element of Array.from(root.querySelectorAll("[data-annotation-id]")) as Element[]) {
        if (element.getAttribute("data-annotation-id") !== key) continue;
        const ancestor = element.parentElement?.closest("[data-annotation-id]");
        if (ancestor?.getAttribute("data-annotation-id") === key) continue;
        matches.add(element);
      }
    }
    return [...matches];
  }

  /**
   * Watches the reader's `_updateState` once for selection, visibility, and annotation-popup
   * changes. Falls back to a short poll when the hook cannot be installed.
   */
  private ensureStateHook(): void {
    if (this.stateHooked) return;
    this.stateHooked = true;
    const reader = this.internalReader;
    const original = reader?._updateState;
    if (reader && typeof original === "function") {
      let live = true;
      const emitSelection = (ids: string[]) => this.emitSelection(ids);
      const emitPopup = (ids: string[]) => this.emitPopup(ids);
      const emitVisibility = () => this.emitVisibility();
      let lastPopup = popupSignature(reader._state);
      const wrapped = function (this: unknown, state: AnyRecord | undefined, ...rest: unknown[]) {
        const result = original.call(this, state, ...rest);
        if (!live || !state) return result;
        if ("annotations" in state || "showAnnotations" in state) emitVisibility();
        if (Array.isArray(state.selectedAnnotationIDs)) {
          emitSelection(state.selectedAnnotationIDs.map(String));
        }
        if ("primaryViewAnnotationPopup" in state || "secondaryViewAnnotationPopup" in state) {
          const next = popupSignature(state);
          if (next !== lastPopup) {
            lastPopup = next;
            emitPopup(popupIDsFromState(state));
          }
        }
        return result;
      };
      try {
        reader._updateState = wrapped;
        if (reader._updateState === wrapped) {
          this.cleanups.push(() => {
            live = false;
            if (reader._updateState === wrapped) reader._updateState = original;
          });
          return;
        }
      } catch {
        live = false;
      }
    }
    const pdfWindow = this.pdfWindow;
    if (!pdfWindow) return;
    let previousVisibility = this.visibilitySignature();
    let previousPopup = popupSignature(this.internalReader?._state);
    const timer = pdfWindow.setInterval(() => {
      const nextVisibility = this.visibilitySignature();
      if (nextVisibility !== previousVisibility) {
        previousVisibility = nextVisibility;
        this.emitVisibility();
      }
      const nextPopup = popupSignature(this.internalReader?._state);
      if (nextPopup !== previousPopup) {
        previousPopup = nextPopup;
        this.emitPopup(this.annotationPopupIDs());
      }
    }, VISIBILITY_POLL_MS);
    this.cleanups.push(() => pdfWindow.clearInterval(timer));
  }

  private emitSelection(ids: string[]): void {
    for (const callback of this.selectionCallbacks) {
      try {
        callback(ids);
      } catch (error) {
        logError(error);
      }
    }
  }

  private emitPopup(ids: string[]): void {
    for (const callback of this.popupCallbacks) {
      try {
        callback(ids);
      } catch (error) {
        logError(error);
      }
    }
  }

  private emitVisibility(): void {
    for (const callback of this.visibilityCallbacks) {
      try {
        callback();
      } catch (error) {
        logError(error);
      }
    }
  }

  private readerDocument(): Document | undefined {
    try {
      return (this.reader?._iframeWindow as Window | undefined)?.document ?? undefined;
    } catch {
      return undefined;
    }
  }

  private visibilitySignature(): string {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return "unavailable";
    const parts = annotations.map(
      (annotation: AnyRecord) => `${String(annotation?.id ?? annotation?.key ?? "")}:${annotation?._hidden ? 1 : 0}`,
    );
    return `${state?.showAnnotations !== false ? 1 : 0}:${parts.join("|")}`;
  }

  private ensureHoverStyle(): void {
    const shadow = this.shadowRoot();
    const doc = this.pdfDocument;
    if (!shadow || !doc || shadow.getElementById(NATIVE_HOVER_STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = NATIVE_HOVER_STYLE_ID;
    style.textContent = NATIVE_HOVER_CSS;
    shadow.append(style);
  }

  private shadowRoot(): ShadowRoot | undefined {
    const direct = this.primaryView?._annotationShadowRoot as ShadowRoot | undefined;
    if (direct?.querySelectorAll) return direct;
    const host = this.pdfDocument?.getElementById("annotation-overlay");
    if (host?.shadowRoot) return host.shadowRoot;
    const root = this.primaryView?._annotationRenderRootEl?.getRootNode?.();
    return root && "host" in root ? (root as ShadowRoot) : undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(value: unknown): Promise<void> {
  if (value && typeof (value as PromiseLike<unknown>).then === "function") await value;
}

function popupIDsFromState(state: AnyRecord | undefined): string[] {
  if (!state) return [];
  const ids: string[] = [];
  for (const key of ["primaryViewAnnotationPopup", "secondaryViewAnnotationPopup"] as const) {
    const popup = state[key];
    const id = popup?.annotation?.id ?? popup?.annotation?.key;
    if (id !== undefined && id !== null) ids.push(String(id));
  }
  return ids;
}

function popupSignature(state: AnyRecord | undefined): string {
  return popupIDsFromState(state).join("|");
}
