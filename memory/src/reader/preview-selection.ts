const DRAG_PX = 4;

interface Caret {
  node: Node;
  offset: number;
}

/**
 * Mouse text selection for the read-only preview. The reader's window-level mousedown handler
 * clears every selection before the browser can start one, so the preview cancels the native
 * press and builds the selection itself from caret positions.
 */
export class PreviewSelection {
  /** True when the last press dragged out a selection, so its click must not open the editor. */
  pressSelected = false;

  private drag?: { pointerId: number; anchor: Caret; x: number; y: number; moved: boolean };

  constructor(private readonly root: HTMLElement) {
    root.addEventListener("pointerdown", (event) => this.onDown(event));
    root.addEventListener("pointermove", (event) => this.onMove(event));
    root.addEventListener("pointerup", (event) => this.onEnd(event));
    root.addEventListener("pointercancel", (event) => this.onEnd(event));
  }

  hasSelection(): boolean {
    const selection = this.selection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return this.root.contains(selection.getRangeAt(0).commonAncestorContainer) && Boolean(selection.toString());
  }

  text(): string {
    return this.hasSelection() ? (this.selection()?.toString() ?? "") : "";
  }

  selectAll(): void {
    this.selection()?.selectAllChildren(this.root);
  }

  private selection(): Selection | null {
    return this.root.ownerDocument.getSelection();
  }

  private onDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const selection = this.selection();
    if (!selection) return;
    const hadSelection = this.hasSelection();
    this.pressSelected = false;
    this.root.focus({ preventScroll: true });

    const caret = this.caretAt(event.clientX, event.clientY);
    if (!caret) return;
    let anchor = caret;
    if (event.shiftKey && hadSelection && selection.anchorNode) {
      anchor = { node: selection.anchorNode, offset: selection.anchorOffset };
      selection.setBaseAndExtent(anchor.node, anchor.offset, caret.node, caret.offset);
      this.pressSelected = true;
    } else {
      selection.collapse(caret.node, caret.offset);
    }
    this.drag = { pointerId: event.pointerId, anchor, x: event.clientX, y: event.clientY, moved: false };
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      // Capture is optional; the drag still works while the pointer stays over the preview.
    }
  }

  private onMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= DRAG_PX) return;
    drag.moved = true;
    this.pressSelected = true;

    const rect = this.root.getBoundingClientRect();
    if (event.clientY < rect.top) this.root.scrollTop -= Math.min(24, rect.top - event.clientY);
    else if (event.clientY > rect.bottom) this.root.scrollTop += Math.min(24, event.clientY - rect.bottom);

    const caret = this.caretAt(event.clientX, event.clientY);
    if (caret) this.selection()?.setBaseAndExtent(drag.anchor.node, drag.anchor.offset, caret.node, caret.offset);
  }

  private onEnd(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    this.drag = undefined;
    try {
      this.root.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
  }

  /** The caret under a point, clamped into the preview so drags past its edges keep extending. */
  private caretAt(clientX: number, clientY: number): Caret | undefined {
    const rect = this.root.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    const doc = this.root.ownerDocument as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    let caret: Caret | undefined;
    const position = doc.caretPositionFromPoint?.(x, y);
    if (position) caret = { node: position.offsetNode, offset: position.offset };
    else {
      const range = doc.caretRangeFromPoint?.(x, y);
      if (range) caret = { node: range.startContainer, offset: range.startOffset };
    }
    return caret && this.root.contains(caret.node) ? caret : undefined;
  }
}
