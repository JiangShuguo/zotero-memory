import { ADDON_ID, ADDON_NAME, CHROME_PACKAGE } from "../constants";
import { ANNOTATION_TYPES, type AnnotationType } from "../model/types";
import { logError, type Settings } from "../settings";
import {
  RELEASES_PAGE,
  checkForUpdates,
  compareVersions,
  installUpdate,
  type ChangeKind,
  type ReleaseNote,
} from "../updates";
import { VERSION } from "../version";

const PANE_ID = "zotero-prefpane-memory";
const RECHECK_AFTER_MS = 30 * 60 * 1000;

const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "新增",
  changed: "优化",
  fixed: "修复",
};

export interface PaneHost {
  settings(): Settings;
  setKind(kind: AnnotationType, visible: boolean): void;
  exportAnnotations(): void;
  importAnnotations(): void;
}

type UpdateState =
  | { kind: "idle" | "checking" | "latest" | "updating" | "updated" }
  | { kind: "available"; latest: string }
  | { kind: "error"; message: string };

/** The Memory pane in Zotero's settings: options, backup buttons, update check and changelog. */
export class PreferencePane {
  private readonly documents = new Set<Document>();
  private paneID?: string;
  private releases: ReleaseNote[] = [];
  private checkedAt = 0;
  private checking?: Promise<void>;
  private update: UpdateState = { kind: "idle" };

  constructor(private readonly host: PaneHost) {}

  async register(): Promise<void> {
    const panes = (Zotero as any).PreferencePanes;
    if (!panes?.register) return;
    try {
      this.paneID = await panes.register({
        pluginID: ADDON_ID,
        id: "memory-preferences",
        label: ADDON_NAME,
        src: `chrome://${CHROME_PACKAGE}/content/preferences.xhtml`,
        image: `chrome://${CHROME_PACKAGE}/content/icons/icon.png`,
        stylesheets: [`chrome://${CHROME_PACKAGE}/content/preferences.css`],
      });
    } catch (error) {
      logError(error);
    }
  }

  unregister(): void {
    this.documents.clear();
    if (!this.paneID) return;
    try {
      (Zotero as any).PreferencePanes?.unregister?.(this.paneID);
    } catch (error) {
      logError(error);
    }
    this.paneID = undefined;
  }

  /** Called by the pane's `onload` handler. */
  bind(win: Window): void {
    const doc = win.document;
    const root = doc.getElementById(PANE_ID);
    if (!root || root.dataset.memBound === "true") return;
    root.dataset.memBound = "true";
    this.documents.add(doc);

    root.querySelectorAll<HTMLInputElement>("[data-mem-type]").forEach((box) => {
      const kind = box.dataset.memType as AnnotationType | undefined;
      if (!kind || !ANNOTATION_TYPES.includes(kind)) return;
      box.addEventListener("change", () => this.host.setKind(kind, box.checked));
    });

    const actions: Record<string, () => void> = {
      export: () => this.host.exportAnnotations(),
      import: () => this.host.importAnnotations(),
      check: () => void this.check(true),
      install: () => void this.install(),
      changelog: () => this.toggleChangelog(root),
      "close-changelog": () => this.toggleChangelog(root, false),
    };
    root.querySelectorAll<HTMLElement>("[data-mem-action]").forEach((button) => {
      const action = actions[button.dataset.memAction ?? ""];
      if (action) button.addEventListener("click", action);
    });
    doc.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.toggleChangelog(root, false);
    });
    doc.addEventListener("pointerdown", (event) => {
      const target = event.target as Element | null;
      if (target?.closest?.('[data-mem-changelog], [data-mem-action="changelog"]')) return;
      this.toggleChangelog(root, false);
    });

    this.sync();
    this.render();
    if (Date.now() - this.checkedAt > RECHECK_AFTER_MS) void this.check(false);
  }

  /** Mirrors the current settings into every open pane. */
  sync(): void {
    const settings = this.host.settings();
    for (const root of this.roots()) {
      root.querySelectorAll<HTMLInputElement>("[data-mem-type]").forEach((box) => {
        const kind = box.dataset.memType as AnnotationType | undefined;
        if (kind) box.checked = settings.kinds.has(kind);
      });
    }
  }

  private roots(): HTMLElement[] {
    const roots: HTMLElement[] = [];
    for (const doc of [...this.documents]) {
      const root = doc.defaultView ? doc.getElementById(PANE_ID) : null;
      if (root) roots.push(root);
      else this.documents.delete(doc);
    }
    return roots;
  }

  // -------------------------------------------------------------------------
  // Updates

  private check(force: boolean): Promise<void> {
    if (this.checking) return this.checking;
    if (!force && this.update.kind === "available") return Promise.resolve();
    this.setUpdate({ kind: "checking" });
    this.checking = (async () => {
      try {
        const result = await checkForUpdates();
        this.releases = result.releases;
        this.checkedAt = Date.now();
        // Only trust a remote answer for "up to date". Local changelog alone can be stale.
        if (result.remote && result.latest && compareVersions(result.latest, VERSION) > 0) {
          this.setUpdate({ kind: "available", latest: result.latest });
          // Install as soon as a newer build is found — no separate click.
          await this.install(result.latest, result.updateLink);
        } else if (result.remote) {
          this.setUpdate({ kind: "latest" });
        } else {
          this.setUpdate({ kind: "error", message: "无法检查更新" });
        }
      } catch (error) {
        logError(error);
        this.setUpdate({ kind: "error", message: "无法检查更新" });
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  private async install(latest = this.update.kind === "available" ? this.update.latest : undefined, updateLink?: string): Promise<void> {
    if (!latest) return;
    this.setUpdate({ kind: "updating" });
    try {
      if (await installUpdate(updateLink)) {
        this.setUpdate({ kind: "updated" });
        return;
      }
    } catch (error) {
      logError(error);
    }
    this.setUpdate({ kind: "available", latest });
    const release = this.releases.find((entry) => entry.version === latest);
    (Zotero as any).launchURL?.(release?.url ?? updateLink ?? RELEASES_PAGE);
  }

  private setUpdate(state: UpdateState): void {
    this.update = state;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering

  private render(): void {
    for (const root of this.roots()) {
      this.renderStatus(root);
      this.renderChangelog(root);
    }
  }

  private renderStatus(root: HTMLElement): void {
    const status = root.querySelector<HTMLElement>("[data-mem-update-status]");
    const version = root.querySelector<HTMLElement>("[data-mem-version]");
    const install = root.querySelector<HTMLButtonElement>('[data-mem-action="install"]');
    const check = root.querySelector<HTMLButtonElement>('[data-mem-action="check"]');
    if (version) version.textContent = `v${VERSION}`;
    if (!status) return;
    const state = this.update;
    const text: Record<UpdateState["kind"], string> = {
      idle: "",
      checking: "检查中…",
      latest: "已是最新",
      available: state.kind === "available" ? `发现 v${state.latest}` : "",
      updating: "正在安装更新…",
      updated: "已更新，请重启 Zotero",
      error: state.kind === "error" ? state.message : "",
    };
    status.textContent = text[state.kind];
    status.dataset.state = state.kind;
    // Manual install is a fallback only when auto-install failed.
    if (install) install.hidden = state.kind !== "available";
    if (check) {
      check.disabled = state.kind === "checking" || state.kind === "updating";
      check.classList.toggle("mem-spinning", state.kind === "checking" || state.kind === "updating");
    }
  }

  private toggleChangelog(root: HTMLElement, open?: boolean): void {
    const panel = root.querySelector<HTMLElement>("[data-mem-changelog]");
    const toggle = root.querySelector<HTMLElement>('[data-mem-action="changelog"]');
    if (!panel) return;
    const show = open ?? panel.hidden;
    if (show === !panel.hidden) return;
    panel.hidden = !show;
    toggle?.setAttribute("aria-expanded", String(show));
    if (show && !this.releases.length) void this.check(true);
  }

  private renderChangelog(root: HTMLElement): void {
    const list = root.querySelector<HTMLElement>("[data-mem-changelog-list]");
    if (!list) return;
    const doc = root.ownerDocument;
    const make = (tag: string, className?: string, text?: string): HTMLElement => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    if (!this.releases.length) {
      const message =
        this.update.kind === "checking" ? "加载中…" : this.update.kind === "error" ? this.update.message : "暂无更新日志";
      list.replaceChildren(make("p", "mem-changelog-empty", message));
      return;
    }
    const entries = this.releases.map((release) => {
      const item = make("article", "mem-release");
      const head = make("div", "mem-release-head");
      head.append(make("span", "mem-release-version", `v${release.version}`));
      const order = compareVersions(release.version, VERSION);
      if (order === 0) head.append(make("span", "mem-badge mem-badge-current", "当前版本"));
      else if (order > 0) head.append(make("span", "mem-badge mem-badge-new", "可更新"));
      head.append(make("span", "mem-release-date", formatDate(release.date)));
      const changes = make("ul", "mem-release-changes");
      for (const change of release.changes) {
        const row = make("li");
        row.append(make("span", `mem-tag mem-tag-${change.kind}`, CHANGE_LABELS[change.kind]), make("span", "", change.text));
        changes.append(row);
      }
      item.append(head, changes);
      return item;
    });
    list.replaceChildren(...entries);
  }
}

function formatDate(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}
