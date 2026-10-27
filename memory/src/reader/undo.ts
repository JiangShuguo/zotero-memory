/**
 * Undo/redo for one open PDF tab. Every step is the before/after state of the annotations one
 * user action touched, as stored in Zotero — deleting a highlight together with its comment is
 * a single step. The history lives only as long as the reader session (closing the tab or
 * Zotero clears it).
 */

export interface AnnotationState {
  key: string;
  type: string;
  text: string;
  comment: string;
  color: string;
  pageLabel: string;
  sortIndex: string;
  /** Raw JSON string, compared as-is. */
  position: string;
  tags: string[];
}

export interface AnnotationChange {
  key: string;
  /** null: the annotation did not exist before (a create). */
  before: AnnotationState | null;
  /** null: the annotation no longer exists afterwards (a delete). */
  after: AnnotationState | null;
}

export interface UndoEntry {
  attachmentID: number;
  changes: AnnotationChange[];
  /** Edit session from a margin card; comment saves in the same session form one step. */
  group?: number;
  at: number;
}

const MAX_DEPTH = 100;
/** Comment saves from outside Memory (sidebar, popup) merge while they keep coming. */
const LOOSE_MERGE_MS = 2000;
/** Zotero may save a new annotation more than once right after creating it. */
const CREATE_SETTLE_MS = 1500;

export type ApplyStates = (entry: UndoEntry, direction: "undo" | "redo") => Promise<void>;

export class UndoHistory {
  private readonly done: UndoEntry[] = [];
  private readonly undone: UndoEntry[] = [];
  private applying = 0;

  get isApplying(): boolean {
    return this.applying > 0;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
  }

  record(entry: UndoEntry): void {
    if (this.applying || !entry.changes.length) return;
    this.undone.length = 0;
    const last = this.done[this.done.length - 1];
    if (last && mergeable(last, entry)) {
      const target = last.changes[0]!;
      target.after = entry.changes[0]!.after;
      last.at = entry.at;
      if (target.before && target.after && sameState(target.before, target.after)) this.done.pop();
      return;
    }
    this.done.push(entry);
    if (this.done.length > MAX_DEPTH) this.done.splice(0, this.done.length - MAX_DEPTH);
  }

  async undo(apply: ApplyStates): Promise<void> {
    const entry = this.done.pop();
    if (!entry) return;
    await this.run(() => apply(entry, "undo"));
    this.undone.push(entry);
  }

  async redo(apply: ApplyStates): Promise<void> {
    const entry = this.undone.pop();
    if (!entry) return;
    await this.run(() => apply(entry, "redo"));
    this.done.push(entry);
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.applying += 1;
    try {
      await task();
    } finally {
      this.applying -= 1;
    }
  }
}

/** Only single-annotation edits merge: a comment typing session, or Zotero settling a new annotation. */
function mergeable(last: UndoEntry, entry: UndoEntry): boolean {
  if (last.attachmentID !== entry.attachmentID) return false;
  if (last.changes.length !== 1 || entry.changes.length !== 1) return false;
  const previous = last.changes[0]!;
  const next = entry.changes[0]!;
  if (previous.key !== next.key || !previous.after || !next.before || !next.after) return false;
  const nextCommentOnly = onlyCommentChanged(next.before, next.after);
  if (!previous.before) {
    // Follow-up saves of a just-created annotation; a comment is always its own step.
    return !nextCommentOnly && entry.at - last.at <= CREATE_SETTLE_MS;
  }
  if (!nextCommentOnly || !onlyCommentChanged(previous.before, previous.after)) return false;
  if (last.group !== undefined || entry.group !== undefined) return last.group === entry.group;
  return entry.at - last.at <= LOOSE_MERGE_MS;
}

/** Current state of every annotation on the attachment that can be restored. */
export function readStates(attachment: any): Map<string, AnnotationState> {
  const states = new Map<string, AnnotationState>();
  let items: any[] = [];
  try {
    items = attachment?.getAnnotations?.(false) ?? [];
  } catch {
    return states;
  }
  for (const item of items) {
    const state = stateOf(item);
    if (state) states.set(state.key, state);
  }
  return states;
}

function stateOf(item: any): AnnotationState | undefined {
  try {
    if (!item?.isAnnotation?.() || item.deleted || item.annotationIsExternal) return undefined;
    const position = item.annotationPosition;
    let tags: string[] = [];
    try {
      tags = (item.getTags?.() ?? [])
        .map((tag: any) => String(tag?.tag ?? ""))
        .filter(Boolean)
        .sort();
    } catch {
      // Tags may not be loaded; they are not part of what Memory edits.
    }
    return {
      key: String(item.key),
      type: String(item.annotationType ?? ""),
      text: String(item.annotationText ?? ""),
      comment: String(item.annotationComment ?? ""),
      color: String(item.annotationColor ?? ""),
      pageLabel: String(item.annotationPageLabel ?? ""),
      sortIndex: String(item.annotationSortIndex ?? ""),
      position: typeof position === "string" ? position : JSON.stringify(position ?? {}),
      tags,
    };
  } catch {
    return undefined;
  }
}

export function sameState(a: AnnotationState, b: AnnotationState): boolean {
  return a.comment === b.comment && sameExceptComment(a, b);
}

export function onlyCommentChanged(a: AnnotationState, b: AnnotationState): boolean {
  return a.comment !== b.comment && sameExceptComment(a, b);
}

function sameExceptComment(a: AnnotationState, b: AnnotationState): boolean {
  return (
    a.type === b.type &&
    a.text === b.text &&
    a.color === b.color &&
    a.pageLabel === b.pageLabel &&
    a.sortIndex === b.sortIndex &&
    a.position === b.position &&
    a.tags.join("\u0000") === b.tags.join("\u0000")
  );
}

/** JSON accepted by Zotero.Annotations.saveFromJSON, which creates or updates by key. */
export function toAnnotationJson(state: AnnotationState): Record<string, unknown> {
  let position: unknown = {};
  try {
    position = JSON.parse(state.position);
  } catch {
    // Keep an empty position rather than failing the whole restore.
  }
  return {
    key: state.key,
    type: state.type,
    text: state.text,
    comment: state.comment,
    color: state.color,
    pageLabel: state.pageLabel,
    sortIndex: state.sortIndex,
    position,
    tags: state.tags.map((name) => ({ name })),
    isExternal: false,
  };
}
