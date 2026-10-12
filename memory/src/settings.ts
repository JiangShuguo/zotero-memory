import { PREF_PREFIX } from "./constants";
import { ANNOTATION_TYPES, type AnnotationType } from "./model/types";

export interface Settings {
  enabled: boolean;
  kinds: ReadonlySet<AnnotationType>;
  compactNotes: boolean;
}

export function readSettings(): Settings {
  const kinds = new Set<AnnotationType>();
  for (const kind of ANNOTATION_TYPES) {
    if (readBool(`types.${kind}`, true)) kinds.add(kind);
  }
  return {
    enabled: readBool("enabled", true),
    kinds,
    compactNotes: readBool("compactNoteIcons", false),
  };
}

export function writeEnabled(enabled: boolean): void {
  writeBool("enabled", enabled);
}

export function writeKind(kind: AnnotationType, visible: boolean): void {
  writeBool(`types.${kind}`, visible);
}

export function writeCompactNotes(enabled: boolean): void {
  writeBool("compactNoteIcons", enabled);
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const value = Zotero.Prefs.get(`${PREF_PREFIX}.${key}`, true);
    return value === undefined ? fallback : Boolean(value);
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    Zotero.Prefs.set(`${PREF_PREFIX}.${key}`, value, true);
  } catch (error) {
    logError(error);
  }
}

export function logError(error: unknown): void {
  try {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Zotero can be gone while the plugin shuts down.
  }
}
