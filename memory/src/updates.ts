import { ADDON_ID, CHROME_PACKAGE, REPOSITORY } from "./constants";

declare const ChromeUtils: { importESModule(path: string): any };

export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;

const UPDATES_URLS = [
  `https://raw.githubusercontent.com/${REPOSITORY}/main/memory/updates.json`,
  `https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/memory/updates.json`,
  `https://fastly.jsdelivr.net/gh/${REPOSITORY}@main/memory/updates.json`,
];

const CHANGELOG_URLS = [
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
  latest?: string;
  updateLink?: string;
  remote: boolean;
  releases: ReleaseNote[];
}

const KINDS = new Set<ChangeKind>(["added", "changed", "fixed"]);

/**
 * Checks for a newer version and loads the changelog.
 * Takes the highest version from every source that answers (raw / jsDelivr / GitHub latest page).
 * AddonManager is not used for the version verdict — its update cache is often stale.
 */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const found: Array<{ version: string; link?: string }> = [];

  const updateDocs = await Promise.all(UPDATES_URLS.map((url) => fetchJson(bust(url))));
  for (const data of updateDocs) {
    const entry = versionFromUpdates(data);
    if (entry) found.push(entry);
  }

  const fromReleasePage = await latestFromGitHubLatestPage();
  if (fromReleasePage) found.push(fromReleasePage);

  const fromApi = await latestFromGitHubApi();
  if (fromApi) found.push(fromApi);

  const remoteChangelogs: ReleaseNote[][] = [];
  for (const data of await Promise.all(CHANGELOG_URLS.map((url) => fetchJson(bust(url))))) {
    if (!data) continue;
    const parsed = parseChangelog(data);
    if (parsed.length) remoteChangelogs.push(parsed);
  }

  const local = parseChangelog(await fetchJson(`chrome://${CHROME_PACKAGE}/content/changelog.json`));
  const releases = mergeReleases(...remoteChangelogs, local);

  const latest = found.length
    ? found.reduce((best, next) => (compareVersions(next.version, best.version) > 0 ? next : best))
    : undefined;

  let updateLink = latest?.link;
  if (latest && !updateLink) {
    updateLink = `https://github.com/${REPOSITORY}/releases/download/v${latest.version}/memory.xpi`;
  }

  return {
    latest: latest?.version,
    updateLink,
    remote: found.length > 0,
    releases,
  };
}

/**
 * Installs an update. Prefers the known XPI URL — AddonManager's own update check is often stale.
 */
export async function installUpdate(updateLink?: string): Promise<boolean> {
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

  const link =
    updateLink ||
    (await checkForUpdates()).updateLink ||
    `https://github.com/${REPOSITORY}/releases/latest/download/memory.xpi`;

  if (await installFromUrl(AddonManager, link)) return true;
  if (await installViaAddonManager(AddonManager)) return true;
  return false;
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

/** Follows GitHub's /releases/latest redirect and reads the tag from the final URL. */
async function latestFromGitHubLatestPage(): Promise<{ version: string; link?: string } | undefined> {
  try {
    const xhr = await Zotero.HTTP.request("GET", `https://github.com/${REPOSITORY}/releases/latest`, {
      headers: { Accept: "text/html", "Cache-Control": "no-cache", Pragma: "no-cache" },
      responseType: "text",
      timeout: 15000,
      noCache: true,
    } as any);
    const finalUrl = String(
      (xhr as any).channel?.URI?.spec ??
        (xhr as any).channel?.currentURI?.spec ??
        (xhr as any).responseURL ??
        "",
    );
    const body = String((xhr as any).responseText ?? (xhr as any).response ?? "");
    const match = /\/releases\/tag\/v?(\d+\.\d+\.\d+)/.exec(finalUrl) || /\/releases\/tag\/v?(\d+\.\d+\.\d+)/.exec(body);
    if (!match?.[1]) return undefined;
    const version = match[1];
    return {
      version,
      link: `https://github.com/${REPOSITORY}/releases/download/v${version}/memory.xpi`,
    };
  } catch {
    return undefined;
  }
}

async function latestFromGitHubApi(): Promise<{ version: string; link?: string } | undefined> {
  try {
    const data = await fetchJson(bust(`https://api.github.com/repos/${REPOSITORY}/releases/latest`));
    const tag = String(data?.tag_name ?? "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+$/.test(tag)) return undefined;
    const asset = Array.isArray(data?.assets)
      ? data.assets.find((item: any) => String(item?.name ?? "") === "memory.xpi")
      : undefined;
    return {
      version: tag,
      link: asset?.browser_download_url
        ? String(asset.browser_download_url)
        : `https://github.com/${REPOSITORY}/releases/download/v${tag}/memory.xpi`,
    };
  } catch {
    return undefined;
  }
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
  for (const args of [[url, "application/x-xpinstall"], [url]] as const) {
    try {
      const install = await AddonManager.getInstallForURL(...args);
      if (!install) continue;
      await install.install();
      return true;
    } catch {
      // try the next signature
    }
  }
  return false;
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
  return `${url}${sep}nocache=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      responseType: "text",
      timeout: 15000,
      noCache: true,
    } as any);
    const text = String((xhr as any).responseText ?? (xhr as any).response ?? "");
    if (!text.trim() || text.trimStart().startsWith("<")) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
