/** Per-reader-tab undo/redo. Cleared when the session is destroyed (leave PDF / quit Zotero). */

export type AnnotationSnapshot = Record<string, unknown>;

export type UndoEntry =
  | {
      kind: "comment";
      key: string;
      itemID: number;
      before: string;
      after: string;
    }
  | {
      kind: "color";
      key: string;
      itemID: number;
      before: string;
      after: string;
    }
  | {
      kind: "delete";
      attachmentID: number;
      /** Original annotation key (for matching cards / redo). */
      key: string;
      snapshot: AnnotationSnapshot;
    };

const MAX_DEPTH = 100;

export class UndoHistory {
  private readonly undoStack: UndoEntry[] = [];
  private readonly redoStack: UndoEntry[] = [];
  private applying = 0;

  get isApplying(): boolean {
    return this.applying > 0;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Records a change. Consecutive comment edits on the same key coalesce into one step. */
  push(entry: UndoEntry): void {
    if (this.applying) return;
    if (entry.kind === "comment" || entry.kind === "color") {
      if (entry.before === entry.after) return;
    }
    const last = this.undoStack[this.undoStack.length - 1];
    if (
      entry.kind === "comment" &&
      last?.kind === "comment" &&
      last.key === entry.key &&
      last.itemID === entry.itemID &&
      last.after === entry.before
    ) {
      last.after = entry.after;
      if (last.before === last.after) this.undoStack.pop();
      this.redoStack.length = 0;
      return;
    }
    this.undoStack.push(entry);
    while (this.undoStack.length > MAX_DEPTH) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * Drops trailing comment steps for a key that never reached Zotero (Esc cancel).
   * Keeps the stack aligned with the last persisted comment.
   */
  discardCommentDrafts(key: string, persisted: string): void {
    if (this.applying) return;
    while (this.undoStack.length) {
      const last = this.undoStack[this.undoStack.length - 1]!;
      if (last.kind !== "comment" || last.key !== key) break;
      if (last.after === persisted) break;
      this.undoStack.pop();
    }
    this.redoStack.length = 0;
  }

  async undo(apply: (entry: UndoEntry, toward: "before" | "after") => Promise<void>): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.applying += 1;
    try {
      await apply(entry, "before");
      this.redoStack.push(entry);
    } finally {
      this.applying -= 1;
    }
    return true;
  }

  async redo(apply: (entry: UndoEntry, toward: "before" | "after") => Promise<void>): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.applying += 1;
    try {
      await apply(entry, "after");
      this.undoStack.push(entry);
    } finally {
      this.applying -= 1;
    }
    return true;
  }
}

/** Best-effort sync snapshot for restoring a deleted annotation. */
export function captureAnnotationSnapshot(item: any): AnnotationSnapshot | undefined {
  if (!item?.isAnnotation?.()) return undefined;
  const Annotations = (Zotero as any).Annotations;
  try {
    if (typeof Annotations?.toJSONSync === "function") {
      const json = Annotations.toJSONSync(item);
      if (json && typeof json === "object") return { ...json, key: String(item.key) };
    }
  } catch {
    // Fall through to field copy.
  }
  try {
    let position: unknown = item.annotationPosition;
    if (typeof position === "string") {
      try {
        position = JSON.parse(position);
      } catch {
        return undefined;
      }
    }
    const tags =
      typeof item.getTags === "function"
        ? (item.getTags() as Array<{ tag?: string; name?: string }>).map((tag) => ({
            name: String(tag.tag ?? tag.name ?? ""),
          }))
        : undefined;
    return {
      key: String(item.key),
      type: String(item.annotationType ?? ""),
      text: String(item.annotationText ?? ""),
      comment: String(item.annotationComment ?? ""),
      color: String(item.annotationColor ?? ""),
      pageLabel: String(item.annotationPageLabel ?? ""),
      sortIndex: String(item.annotationSortIndex ?? ""),
      position,
      tags: tags?.filter((tag) => tag.name),
      isExternal: false,
    };
  } catch {
    return undefined;
  }
}
