import { ADDON_ID, CHROME_PACKAGE, REPOSITORY } from "./constants";

declare const ChromeUtils: { importESModule(path: string): any };

export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

/** Version sources: GitHub raw only. jsDelivr is not used for the version verdict (it can lag). */
const UPDATES_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/updates.json`;

const CHANGELOG_MIRRORS = [
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/addon/content/changelog.json`,
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/addon/content/changelog.json`,
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
  /** XPI download URL for `latest`, when known. */
  updateLink?: string;
  /** True when at least one remote version source answered. */
  remote: boolean;
  releases: ReleaseNote[];
}

const KINDS = new Set<ChangeKind>(["added", "changed", "fixed"]);

/**
 * Checks for a newer version and loads the changelog.
 * The version verdict comes only from GitHub raw `updates.json` and Zotero's AddonManager.
 */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const remoteVersions: string[] = [];
  let updateLink: string | undefined;

  const updates = await fetchJson(bust(UPDATES_URL));
  const fromFile = versionFromUpdates(updates);
  if (fromFile) {
    remoteVersions.push(fromFile.version);
    updateLink = fromFile.link;
  }

  const fromManager = await latestFromAddonManager();
  if (fromManager?.version) {
    remoteVersions.push(fromManager.version);
    updateLink = updateLink ?? fromManager.link;
  }

  const remoteChangelogs: ReleaseNote[][] = [];
  const changelogResults = await Promise.all(CHANGELOG_MIRRORS.map((url) => fetchJson(bust(url))));
  for (const data of changelogResults) {
    if (!data) continue;
    const parsed = parseChangelog(data);
    if (parsed.length) remoteChangelogs.push(parsed);
  }

  const local = parseChangelog(await fetchJson(`chrome://${CHROME_PACKAGE}/content/changelog.json`));
  const releases = mergeReleases(...remoteChangelogs, local);
  const latest = remoteVersions.length
    ? remoteVersions.reduce((best, next) => (compareVersions(next, best) > 0 ? next : best))
    : undefined;

  if (latest && updates) {
    const match = Array.isArray(updates?.addons?.[ADDON_ID]?.updates)
      ? updates.addons[ADDON_ID].updates.find((entry: any) => String(entry?.version ?? "") === latest)
      : undefined;
    if (match?.update_link) updateLink = String(match.update_link);
  }
  if (latest && !updateLink) {
    updateLink = `https://github.com/${REPOSITORY}/releases/download/v${latest}/memory.xpi`;
  }

  return {
    latest,
    updateLink,
    remote: remoteVersions.length > 0,
    releases,
  };
}

/**
 * Installs an update: first through Zotero's add-on manager, then by downloading the XPI URL.
 */
export async function installUpdate(updateLink?: string): Promise<boolean> {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

  const viaManager = await installViaAddonManager(AddonManager);
  if (viaManager) return true;

  const link = updateLink || (await checkForUpdates()).updateLink;
  if (!link) return false;
  return installFromUrl(AddonManager, link);
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

function versionFromUpdates(data: any): { version: string; link?: string } | undefined {
  const updates = data?.addons?.[ADDON_ID]?.updates;
  if (!Array.isArray(updates) || !updates.length) return undefined;
  let best: { version: string; link?: string } | undefined;
  for (const entry of updates) {
    const version = String(entry?.version ?? "").replace(/^v/i, "");
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = {
        version,
        link: entry?.update_link ? String(entry.update_link) : undefined,
      };
    }
  }
  return best;
}

function latestFromAddonManager(): Promise<{ version: string; link?: string } | undefined> {
  return (async () => {
    try {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(ADDON_ID);
      if (!addon) return undefined;
      return await new Promise((resolve) => {
        let settled = false;
        const done = (value?: { version: string; link?: string }) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const timer = setTimeout(() => done(undefined), 12000);
        addon.findUpdates(
          {
            onUpdateAvailable: (_addon: unknown, install: any) => {
              clearTimeout(timer);
              const version = String(install?.version ?? "").replace(/^v/i, "");
              done(version ? { version, link: install?.sourceURI?.spec || install?.url } : undefined);
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

async function installViaAddonManager(AddonManager: any): Promise<boolean> {
  const addon = await AddonManager.getAddonByID(ADDON_ID);
  if (!addon) return false;
  const install = await new Promise<any>((resolve) => {
    let settled = false;
    const done = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), 12000);
    addon.findUpdates(
      {
        onUpdateAvailable: (_addon: unknown, found: unknown) => {
          clearTimeout(timer);
          done(found);
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
  if (!install) return false;
  await install.install();
  return true;
}

async function installFromUrl(AddonManager: any, url: string): Promise<boolean> {
  try {
    const install = await AddonManager.getInstallForURL(url, "application/x-xpinstall");
    if (!install) return false;
    await install.install();
    return true;
  } catch {
    try {
      const install = await AddonManager.getInstallForURL(url);
      if (!install) return false;
      await install.install();
      return true;
    } catch {
      return false;
    }
  }
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
      timeout: 15000,
      noCache: true,
    } as any);
    const text = String((xhr as any).responseText ?? (xhr as any).response ?? "");
    if (!text.trim()) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
