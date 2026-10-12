import { arrangeColumn, type ColumnArrangement, type PlacedCard } from "../model/arrange";
import type { MarginSide } from "../model/types";
import type { PdfPage } from "./bridge";
import type { Card } from "./card";

const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_WIDTH = 264;
const PAGE_GAP = 24;
const ELBOW = 12;
const GUTTER = CARD_WIDTH + PAGE_GAP;
const COLLAPSE_SCALE = 0.8;
const PADDING = 8;
const GAP = 8;
const SUMMARY_HEIGHT = 34;
const EXPANDED_TOP = 48;
const LINE_END_OFFSET = 26;
const FALLBACK_CARD_HEIGHT = 70;
const SIDES: readonly MarginSide[] = ["left", "right"];

export interface OverlayHost {
  isColumnOpen(pageIndex: number, side: MarginSide): boolean;
  setColumnOpen(pageIndex: number, side: MarginSide, open: boolean): void;
  hoveredKey(): string | undefined;
}

interface Column {
  side: MarginSide;
  root: HTMLElement;
  scroller: HTMLElement;
  body: HTMLElement;
  toggle: HTMLButtonElement;
}

/** The margin columns and leader lines of one PDF page. */
export class PageOverlay {
  readonly element: HTMLElement;
  private readonly lines: SVGSVGElement;
  private readonly columns: Record<MarginSide, Column>;
  private page: PdfPage;
  private cards: Card[] = [];
  private places = new Map<string, PlacedCard>();

  constructor(
    doc: Document,
    page: PdfPage,
    private readonly host: OverlayHost,
  ) {
    this.page = page;
    this.element = doc.createElement("div");
    this.element.className = "mem-page-overlay";
    this.element.dataset.pageIndex = String(page.pageIndex);
    this.lines = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.lines.classList.add("mem-lines");
    const layer = doc.createElement("div");
    layer.className = "mem-cards";
    this.columns = { left: this.buildColumn(doc, "left"), right: this.buildColumn(doc, "right") };
    layer.append(this.columns.left.root, this.columns.right.root);
    this.element.append(this.lines, layer);
  }

  get pageIndex(): number {
    return this.page.pageIndex;
  }

  attach(root: HTMLElement, page: PdfPage): void {
    this.page = page;
    if (this.element.parentNode !== root) root.append(this.element);
    this.element.classList.toggle("mem-low-zoom", page.scale < COLLAPSE_SCALE);
  }

  /** Makes `cards` the content of this page. Every card must have an anchor. */
  setCards(cards: Card[]): void {
    const next = new Set(cards);
    for (const card of this.cards) {
      if (!next.has(card) && this.owns(card)) card.element.remove();
    }
    for (const card of cards) {
      const body = this.columns[card.anchor!.side].body;
      // Moving a focused editor would blur it; it moves on the next paint instead.
      if (card.element.parentNode !== body && !(card.isEditing && card.element.isConnected)) {
        body.append(card.element);
      }
    }
    this.cards = cards;
  }

  layout(): void {
    this.place();
    const { width, height } = this.size();
    const plans = SIDES.map((side) => this.plan(side, height));
    this.places.clear();
    for (const plan of plans) this.apply(plan);
    this.lines.style.left = `-${GUTTER}px`;
    this.lines.setAttribute("width", String(width + GUTTER * 2));
    this.lines.setAttribute("height", String(Math.max(1, height)));
    this.lines.setAttribute("viewBox", `${-GUTTER} 0 ${width + GUTTER * 2} ${Math.max(1, height)}`);
    this.drawLines();
  }

  setHovered(key: string | undefined): void {
    for (const node of Array.from(this.lines.children)) {
      node.classList.toggle("mem-hovered", (node as SVGElement).dataset.annotationKey === key);
    }
  }

  destroy(): void {
    for (const card of this.cards) {
      if (this.owns(card)) card.element.remove();
    }
    this.cards = [];
    this.element.remove();
  }

  // -------------------------------------------------------------------------

  private buildColumn(doc: Document, side: MarginSide): Column {
    const root = doc.createElement("section");
    const scroller = doc.createElement("div");
    const body = doc.createElement("div");
    const toggle = doc.createElement("button");
    root.className = `mem-column mem-column-${side}`;
    scroller.className = "mem-scroll";
    body.className = "mem-column-body";
    toggle.type = "button";
    toggle.className = "mem-expand";
    toggle.hidden = true;
    scroller.append(body);
    root.append(scroller, toggle);
    toggle.addEventListener("click", () => this.toggleColumn(side));
    scroller.addEventListener("scroll", () => this.drawLines());
    return { side, root, scroller, body, toggle };
  }

  private toggleColumn(side: MarginSide): void {
    const column = this.columns[side];
    const open = !column.root.classList.contains("mem-expanded");
    this.host.setColumnOpen(this.pageIndex, side, open);
    if (!open) {
      const active = column.root.ownerDocument.activeElement as HTMLElement | null;
      if (active && column.root.contains(active)) active.blur();
      column.scroller.scrollTop = 0;
    }
    this.layout();
  }

  private plan(side: MarginSide, pageHeight: number): { side: MarginSide; cards: Card[]; result: ColumnArrangement; expanded: boolean } {
    const cards = this.cards.filter(
      (card) => card.anchor!.side === side && !card.element.classList.contains("mem-filtered"),
    );
    const editing = cards.some((card) => card.isEditing);
    const wantOpen = this.host.isColumnOpen(this.pageIndex, side);
    const result = arrangeColumn(
      cards.map((card) => ({ id: card.key, anchorY: card.anchor!.y, height: measure(card) })),
      {
        pageHeight,
        padding: PADDING,
        gap: GAP,
        summaryHeight: SUMMARY_HEIGHT,
        expandedTop: EXPANDED_TOP,
        expanded: wantOpen || editing,
      },
    );
    if (!result.overflow && wantOpen) this.host.setColumnOpen(this.pageIndex, side, false);
    return { side, cards, result, expanded: result.overflow && (wantOpen || editing) };
  }

  private apply(plan: { side: MarginSide; cards: Card[]; result: ColumnArrangement; expanded: boolean }): void {
    const { side, cards, result, expanded } = plan;
    const column = this.columns[side];
    if (!expanded) column.scroller.scrollTop = 0;
    column.root.classList.toggle("mem-expanded", expanded);
    column.toggle.hidden = !result.overflow;
    column.toggle.setAttribute("aria-expanded", String(expanded));
    const label = expanded ? "Collapse" : `${result.hiddenIDs.length} more · Show all`;
    if (column.toggle.textContent !== label) column.toggle.textContent = label;
    setPx(column.toggle, "top", expanded ? PADDING : result.summaryY ?? 0);
    setPx(column.body, "height", result.contentHeight);
    const placed = new Map(result.placed.map((place) => [place.id, place]));
    for (const card of cards) {
      const place = placed.get(card.key);
      card.element.classList.toggle("mem-overflow-hidden", !place);
      if (!place) continue;
      this.places.set(card.key, place);
      setPx(card.element, "top", place.y);
    }
  }

  private drawLines(): void {
    const { width, height } = this.size();
    const doc = this.lines.ownerDocument;
    const hovered = this.host.hoveredKey();
    const nodes: SVGElement[] = [];
    for (const card of this.cards) {
      const place = this.places.get(card.key);
      const anchor = card.anchor;
      if (!place || !anchor || card.element.parentNode !== this.columns[anchor.side].body) continue;
      const column = this.columns[anchor.side];
      const expanded = column.root.classList.contains("mem-expanded");
      const cardY = place.y - (expanded ? column.scroller.scrollTop : 0);
      const endY = cardY + Math.min(LINE_END_OFFSET, place.height / 2);
      if (expanded && (endY < 0 || endY > height)) continue;
      const left = anchor.side === "left";
      const elbowX = left ? -ELBOW : width + ELBOW;
      const endX = left ? -PAGE_GAP : width + PAGE_GAP;
      const hot = hovered === card.key;

      const line = doc.createElementNS(SVG_NS, "polyline") as SVGElement;
      line.classList.add("mem-line");
      line.classList.toggle("mem-hovered", hot);
      line.dataset.annotationKey = card.key;
      line.setAttribute("points", `${anchor.x},${anchor.y} ${elbowX},${anchor.y} ${endX},${endY}`);
      line.setAttribute("stroke", card.note.color);

      const dot = doc.createElementNS(SVG_NS, "circle") as SVGElement;
      dot.classList.add("mem-line-dot");
      dot.classList.toggle("mem-hovered", hot);
      dot.dataset.annotationKey = card.key;
      dot.setAttribute("cx", String(anchor.x));
      dot.setAttribute("cy", String(anchor.y));
      dot.setAttribute("r", "2.5");
      dot.setAttribute("fill", card.note.color);
      nodes.push(line, dot);
    }
    this.lines.replaceChildren(...nodes);
  }

  /** Positions the overlay over the page inside the scroll container. */
  private place(): void {
    const root = this.element.parentElement;
    const host = root?.parentElement;
    if (!host) return;
    const element = this.page.element;
    const pageRect = element.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const sized = pageRect.width || pageRect.height;
    const left = sized ? pageRect.left - hostRect.left + host.scrollLeft - host.clientLeft : element.offsetLeft;
    const top = sized ? pageRect.top - hostRect.top + host.scrollTop - host.clientTop : element.offsetTop;
    const { width, height } = this.size(pageRect);
    setPx(this.element, "left", left);
    setPx(this.element, "top", top);
    setPx(this.element, "width", width);
    setPx(this.element, "height", height);
  }

  size(rect = this.page.element.getBoundingClientRect()): { width: number; height: number } {
    const element = this.page.element;
    return {
      width: element.clientWidth || rect.width || this.page.viewport.width,
      height: element.clientHeight || rect.height || this.page.viewport.height,
    };
  }

  private owns(card: Card): boolean {
    const parent = card.element.parentNode;
    return parent === this.columns.left.body || parent === this.columns.right.body;
  }
}

function measure(card: Card): number {
  const height = card.element.getBoundingClientRect().height || card.element.offsetHeight;
  return height > 0 ? height : FALLBACK_CARD_HEIGHT;
}

function setPx(element: HTMLElement, property: "left" | "top" | "width" | "height", value: number): void {
  const next = `${value}px`;
  if (element.style[property] !== next) element.style[property] = next;
}
