const LINE_STEP_PX = 21;
const REPEAT_DELAY_MS = 320;
const REPEAT_EVERY_MS = 60;
const MIN_THUMB_PX = 18;
/** How long the bar stays bright after the last scroll event. */
const SCROLL_ACTIVE_MS = 1400;

/**
 * A drawn scrollbar for one scroll container inside a card. Gecko's native bars cannot be
 * styled to match the card, so the native one is hidden and this one mirrors its state.
 */
export class CardScrollbar {
  readonly element: HTMLElement;

  private readonly track: HTMLElement;
  private readonly thumb: HTMLElement;
  private target?: HTMLElement;
  private frame?: number;
  private repeatTimer?: ReturnType<typeof setTimeout>;
  private scrollActiveTimer?: ReturnType<typeof setTimeout>;
  private readonly observer?: ResizeObserver;
  private readonly onScroll = () => {
    this.pulse();
    this.sync();
  };

  constructor(private readonly doc: Document) {
    this.element = doc.createElement("div");
    this.element.className = "mem-scrollbar";
    this.element.hidden = true;
    this.element.setAttribute("aria-hidden", "true");

    const up = this.arrow("mem-scroll-up", -1);
    this.track = doc.createElement("div");
    this.track.className = "mem-scroll-track";
    this.thumb = doc.createElement("div");
    this.thumb.className = "mem-scroll-thumb";
    this.track.append(this.thumb);
    const down = this.arrow("mem-scroll-down", 1);
    this.element.append(up, this.track, down);

    this.element.addEventListener("pointerdown", (event) => event.preventDefault());
    this.track.addEventListener("pointerdown", (event) => this.onTrackDown(event));
    this.thumb.addEventListener("pointerdown", (event) => this.onThumbDown(event));

    const View = doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
    if (View?.ResizeObserver) this.observer = new View.ResizeObserver(() => this.refresh());
  }

  attach(target: HTMLElement): void {
    if (this.target === target) return this.refresh();
    if (this.target) {
      this.target.removeEventListener("scroll", this.onScroll);
      this.observer?.unobserve(this.target);
    }
    this.target = target;
    target.addEventListener("scroll", this.onScroll);
    this.observer?.observe(target);
    this.refresh();
  }

  /** Re-measures on the next frame, once the content and layout have settled. */
  refresh(): void {
    const view = this.doc.defaultView;
    if (!view || this.frame !== undefined) return;
    this.frame = view.requestAnimationFrame(() => {
      this.frame = undefined;
      this.sync();
    });
  }

  destroy(): void {
    this.stopRepeat();
    if (this.scrollActiveTimer !== undefined) clearTimeout(this.scrollActiveTimer);
    if (this.frame !== undefined) this.doc.defaultView?.cancelAnimationFrame(this.frame);
    this.target?.removeEventListener("scroll", this.onScroll);
    this.observer?.disconnect();
    this.element.remove();
  }

  /** Briefly brightens the bar while the content is being scrolled. */
  private pulse(): void {
    this.element.classList.add("mem-scrolling");
    if (this.scrollActiveTimer !== undefined) clearTimeout(this.scrollActiveTimer);
    this.scrollActiveTimer = setTimeout(() => {
      this.scrollActiveTimer = undefined;
      this.element.classList.remove("mem-scrolling");
    }, SCROLL_ACTIVE_MS);
  }

  private sync(): void {
    const target = this.target;
    const overflow = target ? target.scrollHeight - target.clientHeight : 0;
    if (!target || overflow <= 1 || !target.clientHeight) {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    this.element.style.top = `${target.offsetTop}px`;
    this.element.style.height = `${target.offsetHeight}px`;

    const trackHeight = this.track.clientHeight;
    const thumbHeight = Math.max(MIN_THUMB_PX, (trackHeight * target.clientHeight) / target.scrollHeight);
    const offset = ((trackHeight - thumbHeight) * target.scrollTop) / overflow;
    this.thumb.style.height = `${thumbHeight}px`;
    this.thumb.style.transform = `translateY(${offset}px)`;
  }

  private arrow(className: string, direction: 1 | -1): HTMLElement {
    const arrow = this.doc.createElement("div");
    arrow.className = `mem-scroll-arrow ${className}`;
    arrow.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.repeat(() => this.scrollBy(direction * LINE_STEP_PX), arrow, event.pointerId);
    });
    return arrow;
  }

  private onTrackDown(event: PointerEvent): void {
    if (event.button !== 0 || event.target !== this.track || !this.target) return;
    const target = this.target;
    const direction = event.clientY < this.thumb.getBoundingClientRect().top ? -1 : 1;
    this.repeat(() => {
      const thumb = this.thumb.getBoundingClientRect();
      if (direction < 0 ? event.clientY < thumb.top : event.clientY > thumb.bottom) {
        this.scrollBy(direction * target.clientHeight * 0.9);
      }
    }, this.track, event.pointerId);
  }

  private onThumbDown(event: PointerEvent): void {
    const target = this.target;
    if (event.button !== 0 || !target) return;
    const startY = event.clientY;
    const startScroll = target.scrollTop;
    const range = this.track.clientHeight - this.thumb.offsetHeight;
    const ratio = range > 0 ? (target.scrollHeight - target.clientHeight) / range : 0;
    this.thumb.setPointerCapture(event.pointerId);
    this.element.classList.add("mem-dragging");
    const move = (moveEvent: PointerEvent) => {
      target.scrollTop = startScroll + (moveEvent.clientY - startY) * ratio;
    };
    const end = () => {
      this.element.classList.remove("mem-dragging");
      this.thumb.removeEventListener("pointermove", move);
      this.thumb.removeEventListener("pointerup", end);
      this.thumb.removeEventListener("pointercancel", end);
    };
    this.thumb.addEventListener("pointermove", move);
    this.thumb.addEventListener("pointerup", end);
    this.thumb.addEventListener("pointercancel", end);
  }

  private scrollBy(delta: number): void {
    if (this.target) this.target.scrollTop += delta;
  }

  /** Runs the step now, then keeps repeating it while the pointer stays pressed. */
  private repeat(step: () => void, source: HTMLElement, pointerId: number): void {
    this.stopRepeat();
    step();
    source.setPointerCapture(pointerId);
    const tick = () => {
      step();
      this.repeatTimer = setTimeout(tick, REPEAT_EVERY_MS);
    };
    this.repeatTimer = setTimeout(tick, REPEAT_DELAY_MS);
    const stop = () => {
      this.stopRepeat();
      source.removeEventListener("pointerup", stop);
      source.removeEventListener("pointercancel", stop);
    };
    source.addEventListener("pointerup", stop);
    source.addEventListener("pointercancel", stop);
  }

  private stopRepeat(): void {
    if (this.repeatTimer !== undefined) clearTimeout(this.repeatTimer);
    this.repeatTimer = undefined;
  }
}
