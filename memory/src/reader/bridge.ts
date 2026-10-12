import { logError } from "../settings";
import type { ViewportBox } from "../model/types";
import { compactNotesScript } from "./compact-notes";
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

/** Everything Memory needs from the Zotero PDF reader, kept behind one small interface. */
export class PdfBridge {
  private pdfWindow?: Window & AnyRecord;
  private pdfDocument?: Document;
  private pdfViewer?: AnyRecord;
  private internalReader?: AnyRecord;
  private primaryView?: AnyRecord;
  private readonly cleanups: Cleanup[] = [];
  private hoveredNodes: Element[] = [];
  private compactNotes = false;

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
      const run = () => {
        if (name === "pagerendered" && this.compactNotes) this.applyCompactNotes();
        callback(name);
      };
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
    const reader = this.internalReader;
    const original = reader?._updateState;
    if (reader && typeof original === "function") {
      let live = true;
      const wrapped = function (this: unknown, state: AnyRecord | undefined, ...rest: unknown[]) {
        const result = original.call(this, state, ...rest);
        if (live && state && ("annotations" in state || "showAnnotations" in state)) callback();
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
    let previous = this.visibilitySignature();
    const timer = pdfWindow.setInterval(() => {
      const next = this.visibilitySignature();
      if (next === previous) return;
      previous = next;
      callback();
    }, VISIBILITY_POLL_MS);
    this.cleanups.push(() => pdfWindow.clearInterval(timer));
  }

  onSelection(callback: (ids: string[]) => void): void {
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

  selectedIDs(): string[] {
    const ids = this.internalReader?._state?.selectedAnnotationIDs;
    return Array.isArray(ids) ? ids.map(String) : [];
  }

  /** IDs the reader currently shows, or undefined when the reader state is not readable. */
  visibleIDs(): ReadonlySet<string> | undefined {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return undefined;
    if (state?.showAnnotations === false) return new Set();
    const ids = new Set<string>();
    for (const annotation of annotations) {
      if (!annotation || annotation._hidden) continue;
      const id = annotation.id ?? annotation.key;
      if (id !== undefined && id !== null) ids.add(String(id));
    }
    return ids;
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

  setCompactNotes(enabled: boolean): void {
    this.compactNotes = enabled;
    this.applyCompactNotes();
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
    if (this.compactNotes) this.setCompactNotes(false);
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

  private visibilitySignature(): string {
    const state = this.internalReader?._state;
    const annotations = state?.annotations;
    if (!Array.isArray(annotations)) return "unavailable";
    const parts = annotations.map(
      (annotation: AnyRecord) => `${String(annotation?.id ?? annotation?.key ?? "")}:${annotation?._hidden ? 1 : 0}`,
    );
    return `${state?.showAnnotations !== false ? 1 : 0}:${parts.join("|")}`;
  }

  private applyCompactNotes(): void {
    const readerWindow = this.reader?._iframeWindow as (Window & AnyRecord) | undefined;
    if (typeof readerWindow?.eval !== "function") return;
    try {
      readerWindow.eval(compactNotesScript(this.compactNotes));
    } catch (error) {
      logError(error);
    }
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
