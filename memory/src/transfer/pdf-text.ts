/** Reads per-character text and geometry of a PDF through Zotero's reader. */

export interface PdfChar {
  c: string;
  rect: number[];
  inlineRect?: number[];
  lineBreakAfter?: boolean;
  spaceAfter?: boolean;
  ignorable?: boolean;
  rotation?: number;
}

export interface PdfPageText {
  pageIndex: number;
  chars: PdfChar[];
  viewBox: number[];
  label: string;
}

export interface PdfText {
  pageCount: number;
  pages: PdfPageText[];
}

const OPEN_TIMEOUT_MS = 30000;

/**
 * Uses the reader tab already showing `attachment`, or opens one in the background
 * and closes it again afterwards.
 */
export async function readPdfText(attachment: any): Promise<PdfText> {
  let reader = findReader(attachment.id);
  const opened = !reader;
  if (!reader) {
    reader = await (Zotero as any).Reader.open(attachment.id, undefined, { openInBackground: true });
  }
  if (!reader) throw new Error("无法打开这篇 PDF。");
  try {
    const { pdfDocument, primaryView, win } = await waitForDocument(reader);
    const pageCount = Number(pdfDocument.numPages) || 0;
    const labels = await standardLabels(pdfDocument);
    const pages: PdfPageText[] = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      // The request is posted to the PDF worker, so it must be an object of the reader's own window.
      const request = win.JSON.parse(JSON.stringify({ pageIndex }));
      const data = await pdfDocument.getPageData(request);
      pages.push({
        pageIndex,
        chars: copyChars(data?.chars),
        viewBox: copyNumbers(data?.viewBox) ?? [0, 0, 612, 792],
        label: pageLabel(primaryView, labels, pageIndex),
      });
    }
    return { pageCount, pages };
  } finally {
    if (opened) closeReader(reader);
  }
}

function findReader(itemID: number): any | undefined {
  return ((Zotero as any).Reader?._readers ?? []).find(
    (reader: any) =>
      reader?.itemID === itemID && (reader._type === "pdf" || reader.type === "pdf") && isLiveReader(reader),
  );
}

/** Closed tabs linger in Zotero.Reader._readers until the notifier removes them; their windows are dead. */
export function isLiveReader(reader: any): boolean {
  if (!reader || reader._isTabClosed) return false;
  try {
    const win = reader._iframeWindow;
    return !win || Boolean(win.document);
  } catch {
    return false;
  }
}

async function waitForDocument(reader: any): Promise<{ pdfDocument: any; primaryView: any; win: any }> {
  try {
    await reader._initPromise;
  } catch {
    // keep polling below
  }
  const started = Date.now();
  while (Date.now() - started < OPEN_TIMEOUT_MS) {
    const primaryView = reader._internalReader?._primaryView;
    const win = primaryView?._iframeWindow;
    const pdfDocument = win?.PDFViewerApplication?.pdfDocument;
    if (pdfDocument?.getPageData) return { pdfDocument, primaryView, win };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("读取 PDF 文字超时，请先在 Zotero 中打开这篇 PDF 后再试。");
}

function closeReader(reader: any): void {
  try {
    const win = (Zotero as any).getMainWindow?.();
    if (reader.tabID && win?.Zotero_Tabs) win.Zotero_Tabs.close(reader.tabID);
    else reader.close?.();
  } catch {
    // the tab stays open; harmless
  }
}

async function standardLabels(pdfDocument: any): Promise<string[] | undefined> {
  try {
    const labels = await pdfDocument.getPageLabels?.();
    return Array.isArray(labels) ? labels.map((label: unknown) => String(label ?? "")) : undefined;
  } catch {
    return undefined;
  }
}

function pageLabel(primaryView: any, labels: string[] | undefined, pageIndex: number): string {
  try {
    const label = primaryView?._getPageLabel?.(pageIndex, true);
    if (label) return String(label);
  } catch {
    // fall through
  }
  return labels?.[pageIndex] || String(pageIndex + 1);
}

function copyChars(chars: any): PdfChar[] {
  if (!chars || typeof chars.length !== "number") return [];
  const out: PdfChar[] = [];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const rect = copyNumbers(char?.rect);
    if (!rect) continue;
    out.push({
      c: String(char.c ?? ""),
      rect,
      inlineRect: copyNumbers(char.inlineRect),
      lineBreakAfter: Boolean(char.lineBreakAfter),
      spaceAfter: Boolean(char.spaceAfter),
      ignorable: Boolean(char.ignorable),
      rotation: Number(char.rotation) || 0,
    });
  }
  return out;
}

function copyNumbers(value: any): number[] | undefined {
  if (!value || typeof value.length !== "number" || value.length < 4) return undefined;
  const out = [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  return out.every(Number.isFinite) ? out : undefined;
}
