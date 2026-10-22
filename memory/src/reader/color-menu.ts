import { annotationColorOptions } from "../model/colors";

export interface ColorMenuHost {
  /** The annotation's color, as stored. */
  color(): string;
  /** Whether a color can be picked right now. */
  editable(): boolean;
  pick(color: string): void;
}

/** The color picker that drops down from a card's toolbar button. */
export class ColorMenu {
  readonly element: HTMLElement;
  private open = false;
  private detachDocument?: () => void;

  constructor(
    private readonly doc: Document,
    private readonly card: HTMLElement,
    private readonly button: HTMLButtonElement,
    private readonly host: ColorMenuHost,
  ) {
    const menu = doc.createElement("div");
    menu.className = "mem-color-menu";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Annotation color");
    this.element = menu;

    menu.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0 || !this.host.editable()) return;
      const option = (event.target as HTMLElement | null)?.closest?.("[data-mem-color]") as HTMLElement | null;
      if (!option) return;
      const color = option.dataset.memColor;
      this.hide();
      if (color && color.toLowerCase() !== this.host.color().toLowerCase()) this.host.pick(color);
    });
    for (const name of ["pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
      menu.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** True for the menu and its toggle button. */
  owns(node: Node | null): boolean {
    return Boolean(node && (this.button.contains(node) || this.element.contains(node)));
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    if (this.open || !this.host.editable()) return;
    this.render();
    this.place();
    this.element.hidden = false;
    this.open = true;
    this.button.setAttribute("aria-expanded", "true");
    this.button.classList.add("mem-on");
    this.card.classList.add("mem-menu-open");
    this.listenToDocument();
  }

  hide(): void {
    if (!this.open && this.element.hidden) return;
    this.element.hidden = true;
    this.open = false;
    this.button.setAttribute("aria-expanded", "false");
    this.button.classList.remove("mem-on");
    this.card.classList.remove("mem-menu-open");
    this.detachDocument?.();
    this.detachDocument = undefined;
  }

  /** Redraws the options when the annotation color changes while the menu is open. */
  refresh(): void {
    if (this.open) this.render();
  }

  /** Clicks elsewhere and Escape close the menu; these listeners exist only while it is open. */
  private listenToDocument(): void {
    const onPointer = (event: Event) => {
      if (!this.owns(event.target as Node | null)) this.hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      this.hide();
    };
    this.doc.addEventListener("pointerdown", onPointer, true);
    this.doc.addEventListener("keydown", onKey, true);
    this.detachDocument = () => {
      this.doc.removeEventListener("pointerdown", onPointer, true);
      this.doc.removeEventListener("keydown", onKey, true);
    };
  }

  private place(): void {
    const cardRect = this.card.getBoundingClientRect();
    const buttonRect = this.button.getBoundingClientRect();
    const top = buttonRect.bottom - cardRect.top + 4;
    const left = Math.max(8, Math.min(buttonRect.left - cardRect.left, cardRect.width - 168));
    this.element.style.top = `${top}px`;
    this.element.style.left = `${left}px`;
    this.element.style.right = "auto";
  }

  private render(): void {
    const { colors, showNames } = annotationColorOptions();
    const current = this.host.color().toLowerCase();
    this.element.classList.toggle("mem-with-names", showNames);
    const nodes = colors.map((entry) => {
      const selected = entry.color === current;
      const button = this.doc.createElement("button");
      button.type = "button";
      button.className = "mem-color-option";
      button.tabIndex = -1;
      button.dataset.memColor = entry.color;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", String(selected));
      button.title = entry.label;
      button.setAttribute("aria-label", entry.label);
      if (selected) button.classList.add("mem-on");

      const swatch = this.doc.createElement("span");
      swatch.className = "mem-color-swatch";
      swatch.style.background = entry.color;
      button.append(swatch);

      if (showNames) {
        const label = this.doc.createElement("span");
        label.className = "mem-color-label";
        label.textContent = entry.label;
        const check = this.doc.createElement("span");
        check.className = "mem-color-check";
        check.textContent = selected ? "✓" : "";
        button.append(label, check);
      }
      return button;
    });
    this.element.replaceChildren(...nodes);
  }
}
