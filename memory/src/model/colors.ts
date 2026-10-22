/** Zotero's eight annotation colors, with optional Zotero Style custom labels. */

export interface AnnotationColor {
  color: string;
  label: string;
}

export interface AnnotationColorOptions {
  colors: AnnotationColor[];
  /** True when Style is set to show color names in menus. */
  showNames: boolean;
}

const FALLBACK: AnnotationColor[] = [
  { color: "#ffd400", label: "Yellow" },
  { color: "#ff6666", label: "Red" },
  { color: "#5fb236", label: "Green" },
  { color: "#2ea8e5", label: "Blue" },
  { color: "#a28ae5", label: "Purple" },
  { color: "#e56eee", label: "Magenta" },
  { color: "#f19837", label: "Orange" },
  { color: "#aaaaaa", label: "Gray" },
];

const L10N_KEYS: Record<string, string> = {
  "#ffd400": "general-yellow",
  "#ff6666": "general-red",
  "#5fb236": "general-green",
  "#2ea8e5": "general-blue",
  "#a28ae5": "general-purple",
  "#e56eee": "general-magenta",
  "#f19837": "general-orange",
  "#aaaaaa": "general-gray",
};

/** Keys are relative to the extensions.zotero. branch (Zotero.Prefs default). */
const STYLE_SHOW_NAMES_PREF = "zoterostyle.function.showAnnotationColorName.enable";
const STYLE_COLORS_PREF = "zoterostyle.annotationColors";

/** Palette for the margin-card color button (matches native popup colors). */
export function annotationColorOptions(): AnnotationColorOptions {
  const showNames = readBoolPref(STYLE_SHOW_NAMES_PREF);
  const styled = readZoteroStyleColors();
  if (styled?.length) return { colors: styled, showNames };

  const fromApi = readZoteroColors();
  if (fromApi?.length) return { colors: fromApi, showNames };

  return {
    colors: FALLBACK.map((entry) => ({ ...entry, label: localize(entry.color) || entry.label })),
    showNames,
  };
}

function readBoolPref(key: string): boolean {
  try {
    return Boolean((Zotero as any).Prefs?.get?.(key));
  } catch {
    return false;
  }
}

function readZoteroStyleColors(): AnnotationColor[] | undefined {
  try {
    const raw = (Zotero as any).Prefs?.get?.(STYLE_COLORS_PREF);
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return undefined;
    const colors: AnnotationColor[] = [];
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const label = String(row[0] ?? "").trim();
      const color = normalizeHex(row[1]);
      if (!label || !color) continue;
      colors.push({ label, color });
    }
    return colors.length ? colors : undefined;
  } catch {
    return undefined;
  }
}

function readZoteroColors(): AnnotationColor[] | undefined {
  try {
    const rows = (Zotero as any).Annotations?.COLORS;
    if (!Array.isArray(rows) || !rows.length) return undefined;
    const colors: AnnotationColor[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const color = normalizeHex(row[1]);
      if (!color) continue;
      colors.push({ color, label: localize(color) || String(row[0]) });
    }
    return colors.length ? colors : undefined;
  } catch {
    return undefined;
  }
}

function localize(color: string): string | undefined {
  const key = L10N_KEYS[color.toLowerCase()];
  if (!key) return undefined;
  try {
    const value = (Zotero as any).getString?.(key);
    if (typeof value === "string" && value && value !== key) return value;
  } catch {
    // Fall through.
  }
  return FALLBACK.find((entry) => entry.color === color.toLowerCase())?.label;
}

function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : undefined;
}
