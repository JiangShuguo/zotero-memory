import { MARKS, SIZES, parseComment, renderRich, type Mark } from "../markup/rich-text";
import type { AnnotationType, MarginNote, PageAnchor } from "../model/types";
import { RichEditor, type FormatCommand } from "./rich-editor";
import { PreviewSelection } from "./preview-selection";
import { CardScrollbar } from "./scrollbar";

const SAVE_DELAY_MS = 700;
const STATUS_CLEAR_MS = 1200;

export interface CardHost {
  save(card: Card, value: string): Promise<void>;
  copyText(text: string): void;
  activate(card: Card): void;
  /** Marks the card as current without selecting the annotation in the reader. */
  highlight(card: Card): void;
  hover(card: Card, hovered: boolean): void;
  resized(card: Card): void;
  editingChanged(card: Card): void;
}

interface ToolButton {
  element: HTMLButtonElement;
  command: FormatCommand;
}

const MARK_BUTTONS: Record<Mark, { title: string; html: string }> = {
  b: { title: "Bold (Ctrl+B)", html: "<b>B</b>" },
  i: { title: "Italic (Ctrl+I)", html: "<i>I</i>" },
  u: { title: "Underline (Ctrl+U)", html: "<u>U</u>" },
  s: { title: "Strikethrough", html: "<s>S</s>" },
  sup: { title: "Superscript", html: "x<sup>2</sup>" },
  sub: { title: "Subscript", html: "x<sub>2</sub>" },
};

const LIST_ICON =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 3.5h8M4 7h8M4 10.5h8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="2" cy="3.5" r="0.7"/><circle cx="2" cy="7" r="0.7"/><circle cx="2" cy="10.5" r="0.7"/></svg>';
const CLEAR_ICON =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3h8M7 3v8M3 11.5l8-8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

const TYPE_NAMES: Record<AnnotationType, string> = {
  highlight: "Highlight",
  underline: "Underline",
  note: "Note",
  text: "Text annotation",
  image: "Image annotation",
};
/** One margin card. It owns its DOM, its draft and its autosave timer. */
export class Card {
  readonly element: HTMLElement;
  anchor?: PageAnchor;

  private model: MarginNote;
  private readonly bar: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly editorElement: HTMLElement;
  private readonly status: HTMLElement;
  private readonly editor: RichEditor;
  private readonly scrollbar: CardScrollbar;
  private readonly selection: PreviewSelection;
  private readonly buttons: ToolButton[] = [];
  private saved: string;
  private draft: string;
  private dirty = false;
  private saving = false;
  private editing = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly doc: Document,
    note: MarginNote,
    private readonly host: CardHost,
  ) {
    this.model = note;
    this.saved = note.comment;
    this.draft = note.comment;

    this.element = doc.createElement("article");
    this.element.className = "mem-card";
    this.element.dataset.annotationKey = note.key;

    this.bar = this.buildToolbar();

    this.preview = doc.createElement("div");
    this.preview.className = "mem-preview";
    this.preview.tabIndex = 0;
    this.preview.setAttribute("role", "button");
    this.selection = new PreviewSelection(this.preview);

    this.editorElement = doc.createElement("div");
    this.editorElement.className = "mem-editor";
    this.editorElement.spellcheck = false;
    this.editorElement.dir = "auto";
    this.editorElement.setAttribute("role", "textbox");
    this.editorElement.setAttribute("aria-multiline", "true");
    this.editor = new RichEditor(this.editorElement);

    const footer = doc.createElement("footer");
    footer.className = "mem-footer";
    this.status = doc.createElement("span");
    this.status.className = "mem-status";
    footer.append(this.status);

    this.scrollbar = new CardScrollbar(doc);
    this.element.append(this.bar, this.preview, this.editorElement, footer, this.scrollbar.element);
    this.applyNote();
    this.editor.load(this.draft);
    this.renderPreview();
    this.bindCard();
    this.bindEditor();
    this.bindToolbar();
    this.scrollbar.attach(this.preview);
  }

  get key(): string {
    return this.model.key;
  }

  get note(): MarginNote {
    return this.model;
  }

  get isEditing(): boolean {
    return this.editing;
  }

  /** True while the card holds text that Zotero may not have yet. */
  get busy(): boolean {
    return this.editing || this.dirty || this.saving;
  }

  update(note: MarginNote): void {
    const previous = this.model;
    this.model = note;
    if (previous.color !== note.color || previous.readOnly !== note.readOnly || previous.type !== note.type) {
      this.applyNote();
    } else if (previous.pageLabel !== note.pageLabel) {
      this.applyLabels();
    }
    if (!this.busy && note.comment !== this.saved) {
      this.saved = note.comment;
      this.draft = note.comment;
      this.editor.load(note.comment);
      this.renderPreview();
      this.host.resized(this);
    }
  }

  open(selectAll = false): void {
    if (this.model.readOnly) return;
    if (!this.editing) {
      this.editing = true;
      this.element.classList.add("mem-editing");
      this.scrollbar.attach(this.editorElement);
      this.host.editingChanged(this);
    }
    this.editorElement.focus({ preventScroll: true });
    if (selectAll) this.editor.selectAll();
    else this.editor.caretToEnd();
    this.syncToolbar();
  }

  destroy(): void {
    this.clearTimers();
    if (this.dirty && !this.saving) void this.persist();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.scrollbar.destroy();
    this.element.remove();
  }

  // -------------------------------------------------------------------------
  // DOM wiring

  private bindCard(): void {
    const card = this.element;
    card.addEventListener("pointerenter", () => this.host.hover(this, true));
    card.addEventListener("pointerleave", () => this.host.hover(this, false));
    card.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (this.editorElement.contains(target)) return;
      // Skips the reader's mousedown handler, which would drop the annotation selection.
      event.preventDefault();
      if (this.scrollbar.element.contains(target) || this.preview.contains(target)) return;
      if (event.button === 0) this.host.activate(this);
    });
    for (const name of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) {
      card.addEventListener(name, (event) => event.stopPropagation());
    }
    this.preview.addEventListener("click", (event) => {
      // Press-and-drag selects text for reading; a plain click opens the editor.
      if (event.button !== 0 || this.selection.pressSelected) return;
      // Selecting the annotation here would let the reader take focus from the new editor.
      this.host.highlight(this);
      this.open();
    });
    this.preview.addEventListener("keydown", (event) => {
      const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const key = event.key.toLowerCase();
      if (mod && (key === "c" || key === "a")) {
        // Zotero's copy handler would put the whole annotation on the clipboard instead.
        event.preventDefault();
        event.stopPropagation();
        if (key === "a") this.selection.selectAll();
        else if (this.selection.hasSelection()) this.host.copyText(this.selection.text());
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.open();
    });
  }

  private bindEditor(): void {
    const editor = this.editorElement;
    editor.addEventListener("input", () => this.onInput());
    editor.addEventListener("keydown", (event) => this.onKeyDown(event));
    editor.addEventListener("keyup", () => this.syncToolbar());
    editor.addEventListener("pointerup", () => this.syncToolbar());
    editor.addEventListener("paste", (event) => this.onPaste(event));
    editor.addEventListener("drop", (event) => event.preventDefault());
    editor.addEventListener("focusout", () => this.deferCloseCheck());

    const onSelection = () => {
      if (this.editing) this.editor.rememberSelection();
    };
    this.doc.addEventListener("selectionchange", onSelection);
    this.cleanups.push(() => this.doc.removeEventListener("selectionchange", onSelection));
  }

  private bindToolbar(): void {
    const bar = this.bar;
    bar.addEventListener("pointerdown", (event) => {
      // Cancelling pointerdown suppresses the compatibility mousedown, in which the
      // reader would clear the document selection, and keeps the focus in the editor.
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      const tool = this.buttons.find((entry) => entry.element.contains(event.target as Node));
      if (tool) this.run(tool.command);
    });
    for (const name of ["pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
      bar.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.keepFocus();
      });
    }
    bar.addEventListener("focusin", () => this.keepFocus());
  }

  private buildToolbar(): HTMLElement {
    const doc = this.doc;
    const bar = doc.createElement("div");
    bar.className = "mem-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Text formatting");
    const add = (title: string, html: string, command: FormatCommand, extraClass?: string) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.innerHTML = html;
      if (extraClass) button.classList.add(extraClass);
      bar.append(button);
      this.buttons.push({ element: button, command });
    };
    const separator = () => {
      const node = doc.createElement("span");
      node.className = "mem-sep";
      bar.append(node);
    };
    for (const mark of MARKS) {
      add(MARK_BUTTONS[mark].title, MARK_BUTTONS[mark].html, { kind: "mark", mark });
      if (mark === "s" || mark === "sub") separator();
    }
    for (const size of SIZES) {
      add(`Font size ${size}`, String(size), { kind: "size", size }, "mem-size");
    }
    separator();
    add("Bulleted list", LIST_ICON, { kind: "list" });
    add("Clear formatting", CLEAR_ICON, { kind: "clear" });
    return bar;
  }

  // -------------------------------------------------------------------------
  // Editing

  private run(command: FormatCommand): void {
    if (!this.editing || this.model.readOnly) return;
    if (this.doc.activeElement !== this.editorElement) {
      this.editorElement.focus({ preventScroll: true });
    }
    this.editor.apply(command);
    this.onInput();
  }

  /** Brings the focus back to the editor and restores the last selection inside it. */
  private keepFocus(): void {
    if (!this.editing || this.doc.activeElement === this.editorElement) return;
    this.editorElement.focus({ preventScroll: true });
    this.editor.restoreSelection();
  }

  private onInput(): void {
    if (this.model.readOnly) return;
    this.draft = this.editor.value();
    this.dirty = this.draft !== this.saved;
    this.setStatus(this.dirty ? "Unsaved" : "");
    this.renderPreview();
    this.syncToolbar();
    if (this.dirty) this.queueSave();
    else this.clearSaveTimer();
    this.host.resized(this);
  }

  private onKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (mod && event.key === "Enter") {
      event.preventDefault();
      void this.persist().then(() => this.editorElement.blur());
      return;
    }
    if (!mod || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "b" || key === "i" || key === "u") {
      event.preventDefault();
      this.run({ kind: "mark", mark: key });
    } else if (key === "a") {
      event.preventDefault();
      this.editor.selectAll();
    } else if (key === "c" || key === "x") {
      // The reader's own copy handler would put the selected annotation on the clipboard instead.
      event.preventDefault();
      this.copySelection(key === "x");
    }
  }

  private copySelection(cut: boolean): void {
    const text = this.editor.selectedText();
    if (!text) return;
    this.host.copyText(text);
    if (cut && this.editing && !this.model.readOnly) {
      this.doc.getSelection()?.deleteFromDocument();
      this.onInput();
    }
  }

  private onPaste(event: ClipboardEvent): void {
    event.stopPropagation();
    event.preventDefault();
    if (!this.editing || this.model.readOnly) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const selection = this.doc.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!this.editorElement.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const node = this.doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    this.editor.normalize();
    this.onInput();
  }

  private deferCloseCheck(): void {
    const check = () => {
      if (!this.editing) return;
      const active = this.doc.activeElement;
      if (active && this.element.contains(active)) {
        this.keepFocus();
        return;
      }
      void this.persist().finally(() => {
        const still = this.doc.activeElement;
        if (still && this.element.contains(still)) return;
        this.close();
      });
    };
    const view = this.doc.defaultView;
    if (view) view.setTimeout(check, 0);
    else setTimeout(check, 0);
  }

  private close(): void {
    if (!this.editing) return;
    this.editing = false;
    this.element.classList.remove("mem-editing");
    this.renderPreview();
    this.scrollbar.attach(this.preview);
    this.host.editingChanged(this);
  }

  private cancel(): void {
    this.clearSaveTimer();
    this.draft = this.saved;
    this.dirty = false;
    this.editor.load(this.saved);
    this.renderPreview();
    this.setStatus("Cancelled", { autoClear: true });
    this.close();
    this.editorElement.blur();
  }

  private queueSave(): void {
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist();
    }, SAVE_DELAY_MS);
  }

  private async persist(): Promise<void> {
    this.clearSaveTimer();
    if (!this.dirty || this.saving || this.model.readOnly) return;
    const value = this.draft;
    this.saving = true;
    this.setStatus("Saving…");
    try {
      await this.host.save(this, value);
      this.saved = value;
      this.model = { ...this.model, comment: value };
      this.dirty = this.draft !== value;
      if (this.dirty) this.setStatus("Unsaved");
      else this.setStatus("Saved", { autoClear: true });
    } catch (error) {
      this.dirty = true;
      this.setStatus(error instanceof Error ? error.message : "Could not save the comment", { error: true });
    } finally {
      this.saving = false;
      if (this.dirty && this.draft !== value) this.queueSave();
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private applyNote(): void {
    const note = this.model;
    this.element.style.setProperty("--mem-color", note.color);
    // The reader treats only contenteditable="true" as a text box when it handles shortcuts.
    this.editorElement.setAttribute("contenteditable", note.readOnly ? "false" : "true");
    this.editorElement.setAttribute("aria-readonly", String(note.readOnly));
    this.editorElement.dataset.placeholder =
      note.type === "note" ? "Click to add a comment" : "Click to comment on this annotation";
    this.applyLabels();
    this.setStatus(this.status.textContent === "Read-only" ? "" : this.status.textContent ?? "");
    this.renderPreview();
  }

  private applyLabels(): void {
    const note = this.model;
    const label = `${TYPE_NAMES[note.type]}, page ${note.pageLabel || note.position.pageIndex + 1}`;
    this.preview.setAttribute("aria-label", `${note.readOnly ? "View" : "Edit"} comment: ${label}`);
    this.editorElement.setAttribute("aria-label", `Comment: ${label}`);
  }

  private renderPreview(): void {
    if (this.draft) {
      this.preview.replaceChildren(renderRich(this.doc, parseComment(this.draft), "preview").fragment);
    } else {
      this.preview.textContent = this.editorElement.dataset.placeholder ?? "";
    }
    this.preview.classList.toggle("mem-empty", !this.draft);
    this.scrollbar.refresh();
  }

  private syncToolbar(): void {
    if (!this.editing) return;
    const state = this.editor.state();
    for (const { element, command } of this.buttons) {
      let on = false;
      if (command.kind === "mark") on = state.marks.has(command.mark);
      else if (command.kind === "size") on = state.size === command.size;
      else if (command.kind === "list") on = state.list;
      element.classList.toggle("mem-on", on);
      element.setAttribute("aria-pressed", String(on));
    }
  }

  private setStatus(text: string, options: { error?: boolean; autoClear?: boolean } = {}): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    const value = text || (this.model.readOnly ? "Read-only" : "");
    const changed = this.status.textContent !== value;
    this.status.textContent = value;
    this.status.classList.toggle("mem-error", Boolean(options.error));
    this.element.classList.toggle("mem-has-status", Boolean(value));
    if (options.autoClear) {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = undefined;
        if (!this.dirty && !this.saving) this.setStatus("");
      }, STATUS_CLEAR_MS);
    }
    if (changed) this.host.resized(this);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  private clearTimers(): void {
    this.clearSaveTimer();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
  }
}
