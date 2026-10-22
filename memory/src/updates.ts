import { ADDON_ID, CHROME_PACKAGE, REPOSITORY } from "./constants";

declare const ChromeUtils: { importESModule(path: string): any };

export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

/** Prefer GitHub raw (fresh); jsDelivr is a fallback and may lag behind. */
const CHANGELOG_MIRRORS = [
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/addon/content/changelog.json`,
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/addon/content/changelog.json`,
];

const UPDATES_MIRRORS = [
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/updates.json`,
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/updates.json`,
];

export type ChangeKind = "added" | "changed" | "fixed";

export interface ReleaseNote {
  version: string;
  date: Date | undefined;
  url: string;
  changes: Array<{ kind: ChangeKind; text: string }>;
}

export interface UpdateCheck {
  /** Newest version seen from a remote source. */
  latest?: string;
  /** True when at least one remote mirror answered. */
  remote: boolean;
  releases: ReleaseNote[];
}

const KINDS = new Set<ChangeKind>(["added", "changed", "fixed"]);

/**
 * Checks for a newer version and loads the changelog.
 * Remote mirrors are preferred for the version verdict; the bundled changelog is only a display fallback.
 */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const remoteVersions: string[] = [];
  const remoteChangelogs: ReleaseNote[][] = [];

  const updateResults = await Promise.all(UPDATES_MIRRORS.map((url) => fetchJson(bust(url))));
  for (const data of updateResults) {
    const version = versionFromUpdates(data);
    if (version) remoteVersions.push(version);
  }

  const managerVersion = await latestFromAddonManager();
  if (managerVersion) remoteVersions.push(managerVersion);

  const changelogResults = await Promise.all(CHANGELOG_MIRRORS.map((url) => fetchJson(bust(url))));
  for (const data of changelogResults) {
    if (!data) continue;
    const parsed = parseChangelog(data);
    if (parsed.length) {
      remoteChangelogs.push(parsed);
      const top = parsed[0]?.version;
      if (top) remoteVersions.push(top);
    }
  }

  const local = parseChangelog(await fetchJson(`chrome://${CHROME_PACKAGE}/content/changelog.json`));
  const releases = mergeReleases(...remoteChangelogs, local);
  const latest = remoteVersions.length
    ? remoteVersions.reduce((best, next) => (compareVersions(next, best) > 0 ? next : best))
    : undefined;

  return {
    latest,
    remote: remoteVersions.length > 0,
    releases,
  };
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

function versionFromUpdates(data: any): string | undefined {
  const updates = data?.addons?.[ADDON_ID]?.updates;
  if (!Array.isArray(updates) || !updates.length) return undefined;
  return updates
    .map((entry: any) => String(entry?.version ?? "").replace(/^v/i, ""))
    .filter(Boolean)
    .reduce((best: string | undefined, next: string) =>
      !best || compareVersions(next, best) > 0 ? next : best,
    undefined);
}

/** Asks Zotero's own updater (same `update_url` as the XPI) for a newer build. */
function latestFromAddonManager(): Promise<string | undefined> {
  return (async () => {
    try {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(ADDON_ID);
      if (!addon) return undefined;
      return await new Promise<string | undefined>((resolve) => {
        let settled = false;
        const done = (version?: string) => {
          if (settled) return;
          settled = true;
          resolve(version);
        };
        const timer = setTimeout(() => done(undefined), 10000);
        addon.findUpdates(
          {
            onUpdateAvailable: (_addon: unknown, install: any) => {
              clearTimeout(timer);
              done(String(install?.version ?? "").replace(/^v/i, "") || undefined);
            },
            onNoUpdateAvailable: () => {
              clearTimeout(timer);
              done(undefined);
            },
            onUpdateFinished: () => {
              clearTimeout(timer);
              done(undefined);
            },
          },
          AddonManager.UPDATE_WHEN_USER_REQUESTED,
        );
      });
    } catch {
      return undefined;
    }
  })();
}

function parseChangelog(data: any): ReleaseNote[] {
  if (!data) return [];
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

function mergeReleases(...lists: ReleaseNote[][]): ReleaseNote[] {
  const byVersion = new Map<string, ReleaseNote>();
  for (const list of lists) {
    for (const release of list) {
      const existing = byVersion.get(release.version);
      if (!existing || release.changes.length > existing.changes.length) {
        byVersion.set(release.version, release);
      }
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
}

function bust(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
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
