import { arrangeColumn, type ColumnArrangement, type PlacedCard } from "../model/arrange";
import type { MarginSide } from "../model/types";
import type { PdfPage } from "./bridge";
import type { Card } from "./card";
import { CardScrollbar } from "./scrollbar";

const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_WIDTH = 264;
const PAGE_GAP = 24;
const ELBOW = 12;
const GUTTER = CARD_WIDTH + PAGE_GAP;
const COLLAPSE_SCALE = 0.8;
const PADDING = 8;
const GAP = 8;
const REVEAL_MARGIN = 32;
const LINE_END_OFFSET = 26;
const FALLBACK_CARD_HEIGHT = 70;
const SIDES: readonly MarginSide[] = ["left", "right"];

export interface OverlayHost {
  hoveredKey(): string | undefined;
}

interface Column {
  side: MarginSide;
  root: HTMLElement;
  scroller: HTMLElement;
  body: HTMLElement;
  bar: CardScrollbar;
}

interface ColumnPlan {
  side: MarginSide;
  cards: Card[];
  result: ColumnArrangement;
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

  /** Scrolls an overflowing column so the card is fully visible. */
  reveal(key: string): void {
    const card = this.cards.find((candidate) => candidate.key === key);
    const place = this.places.get(key);
    if (!card || !place) return;
    const { scroller } = this.columns[card.anchor!.side];
    const view = scroller.clientHeight;
    if (scroller.scrollHeight <= view + 1) return;
    // Keep the card clear of the edge fades.
    const top = place.y - REVEAL_MARGIN;
    const bottom = place.y + place.height + REVEAL_MARGIN;
    let next = scroller.scrollTop;
    if (top < next) next = top;
    else if (bottom > next + view) next = Math.min(top, bottom - view);
    if (next !== scroller.scrollTop) scroller.scrollTo({ top: next, behavior: "smooth" });
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
    for (const side of SIDES) this.columns[side].bar.destroy();
    this.element.remove();
  }

  // -------------------------------------------------------------------------

  private buildColumn(doc: Document, side: MarginSide): Column {
    const root = doc.createElement("section");
    const scroller = doc.createElement("div");
    const body = doc.createElement("div");
    root.className = `mem-column mem-column-${side}`;
    scroller.className = "mem-scroll";
    body.className = "mem-column-body";
    const bar = new CardScrollbar(doc);
    scroller.append(body);
    root.append(scroller, bar.element);
    bar.attach(scroller);
    scroller.addEventListener("scroll", () => {
      this.syncFades(scroller);
      this.drawLines();
    });
    return { side, root, scroller, body, bar };
  }

  /** Fades the scroller edges only where more cards are hidden beyond them. */
  private syncFades(scroller: HTMLElement): void {
    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.classList.toggle("mem-fade-top", scroller.scrollTop > 1);
    scroller.classList.toggle("mem-fade-bottom", max > 1 && scroller.scrollTop < max - 1);
  }

  private plan(side: MarginSide, pageHeight: number): ColumnPlan {
    const cards = this.cards.filter(
      (card) => card.anchor!.side === side && !card.element.classList.contains("mem-filtered"),
    );
    const result = arrangeColumn(
      cards.map((card) => ({ id: card.key, anchorY: card.anchor!.y, height: measure(card) })),
      { pageHeight, padding: PADDING, gap: GAP },
    );
    return { side, cards, result };
  }

  private apply({ side, cards, result }: ColumnPlan): void {
    const column = this.columns[side];
    if (!result.overflow) column.scroller.scrollTop = 0;
    column.root.classList.toggle("mem-overflowing", result.overflow);
    setPx(column.body, "height", result.contentHeight);
    this.syncFades(column.scroller);
    column.bar.refresh();
    for (const place of result.placed) {
      this.places.set(place.id, place);
      const card = cards.find((candidate) => candidate.key === place.id)!;
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
      const endY = place.y - column.scroller.scrollTop + Math.min(LINE_END_OFFSET, place.height / 2);
      if (endY < 0 || endY > height) continue;
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
