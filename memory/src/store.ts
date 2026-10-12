import { isAnnotationType, readPosition } from "./model/anchor";
import type { MarginNote } from "./model/types";

const FALLBACK_COLOR = "#ffd400";

/** Reads annotations from Zotero and writes comments back. */
export class NoteStore {
  list(attachmentID: number): MarginNote[] {
    const attachment = Zotero.Items.get(attachmentID) as any;
    if (!attachment || typeof attachment.getAnnotations !== "function") return [];
    const notes: MarginNote[] = [];
    for (const item of attachment.getAnnotations(false)) {
      const note = toNote(item);
      if (note) notes.push(note);
    }
    return notes;
  }

  async saveComment(itemID: number, value: string): Promise<void> {
    const item = Zotero.Items.get(itemID) as any;
    if (!item?.isAnnotation?.()) throw new Error("This annotation no longer exists");
    if (item.isEditable?.() === false) throw new Error("This annotation is read-only");
    item.annotationComment = value;
    await item.saveTx();
  }
}

function toNote(item: any): MarginNote | undefined {
  if (!item?.isAnnotation?.() || !isAnnotationType(item.annotationType)) return undefined;
  const position = readPosition(item.annotationPosition);
  if (!position) return undefined;
  const color = typeof item.annotationColor === "string" && /^#[0-9a-f]{6}$/i.test(item.annotationColor)
    ? item.annotationColor
    : FALLBACK_COLOR;
  return {
    itemID: Number(item.id),
    key: String(item.key),
    type: item.annotationType,
    comment: String(item.annotationComment ?? ""),
    color,
    pageLabel: String(item.annotationPageLabel ?? position.pageIndex + 1),
    position,
    readOnly: item.isEditable?.() === false,
  };
}
