import { ADDON_ID, CHROME_PACKAGE, REPOSITORY } from "./constants";

declare const ChromeUtils: { importESModule(path: string): any };

export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

const CHANGELOG_MIRRORS = [
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/addon/content/changelog.json`,
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/addon/content/changelog.json`,
];

const UPDATES_MIRRORS = [
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/updates.json`,
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/updates.json`,
];

export type ChangeKind = "added" | "changed" | "fixed";

export interface ReleaseNote {
  version: string;
  date: Date | undefined;
  url: string;
  changes: Array<{ kind: ChangeKind; text: string }>;
}

const KINDS = new Set<ChangeKind>(["added", "changed", "fixed"]);

/**
 * Loads the changelog for the prefs pane.
 * Prefers a remote mirror (jsDelivr / raw.githubusercontent.com); falls back to the copy
 * bundled in the XPI so the list still works when GitHub API is unreachable.
 */
export async function fetchReleases(): Promise<{ releases: ReleaseNote[]; remote: boolean }> {
  const remote = await fetchJsonFromMirrors(CHANGELOG_MIRRORS);
  if (remote) return { releases: parseChangelog(remote), remote: true };

  const local = await fetchJson(`chrome://${CHROME_PACKAGE}/content/changelog.json`);
  if (local) return { releases: parseChangelog(local), remote: false };

  throw new Error("Could not load the changelog");
}

/** Newest version listed in `updates.json`, or undefined when every mirror fails. */
export async function fetchLatestVersion(): Promise<string | undefined> {
  const data = await fetchJsonFromMirrors(UPDATES_MIRRORS);
  const updates = data?.addons?.[ADDON_ID]?.updates;
  if (!Array.isArray(updates) || !updates.length) return undefined;
  return updates
    .map((entry: any) => String(entry?.version ?? ""))
    .filter(Boolean)
    .sort(compareVersions)
    .at(-1);
}

/**
 * Installs the newest version listed in `updates.json` through Zotero's add-on manager.
 * Resolves false when the manager finds nothing to install.
 */
export async function installUpdate(): Promise<boolean> {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID(ADDON_ID);
  if (!addon) return false;
  const install = await new Promise<any>((resolve) => {
    addon.findUpdates(
      {
        onUpdateAvailable: (_addon: unknown, found: unknown) => resolve(found),
        onNoUpdateAvailable: () => resolve(undefined),
        onUpdateFinished: () => resolve(undefined),
      },
      AddonManager.UPDATE_WHEN_USER_REQUESTED,
    );
  });
  if (!install) return false;
  await install.install();
  return true;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function parseChangelog(data: any): ReleaseNote[] {
  const list = Array.isArray(data?.releases) ? data.releases : Array.isArray(data) ? data : [];
  return list
    .map((entry: any) => {
      const version = String(entry?.version ?? "").replace(/^v/i, "");
      if (!version) return undefined;
      const changes = Array.isArray(entry.changes)
        ? entry.changes
            .map((change: any) => {
              const kind = String(change?.kind ?? "") as ChangeKind;
              const text = String(change?.text ?? "").trim();
              if (!KINDS.has(kind) || !text) return undefined;
              return { kind, text };
            })
            .filter(Boolean)
        : [];
      return {
        version,
        date: entry.date ? new Date(String(entry.date)) : undefined,
        url: `${RELEASES_PAGE}/tag/v${version}`,
        changes,
      } satisfies ReleaseNote;
    })
    .filter((entry: ReleaseNote | undefined): entry is ReleaseNote => Boolean(entry))
    .sort((a: ReleaseNote, b: ReleaseNote) => compareVersions(b.version, a.version));
}

async function fetchJsonFromMirrors(urls: readonly string[]): Promise<any | undefined> {
  for (const url of urls) {
    const data = await fetchJson(url);
    if (data !== undefined) return data;
  }
  return undefined;
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: { Accept: "application/json" },
      responseType: "text",
      timeout: 12000,
      noCache: true,
    } as any);
    const text = String((xhr as any).responseText ?? (xhr as any).response ?? "");
    if (!text.trim()) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
