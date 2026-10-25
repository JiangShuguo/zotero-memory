import { ADDON_ID, ADDON_NAME, CHROME_PACKAGE, PREF_PREFIX } from "../constants";
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
const PANE_PREF_ID = "memory-preferences";
const REOPEN_PREFS_KEY = `${PREF_PREFIX}.reopenPrefs`;
const RECHECK_AFTER_MS = 30 * 60 * 1000;

const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "新增",
  changed: "优化",
  fixed: "修复",
};

export interface PaneHost {
  settings(): Settings;
  setKind(kind: AnnotationType, visible: boolean): void;
  batchExportAnnotations(ownerWindow?: Window): void;
  batchImportAnnotations(ownerWindow?: Window): void;
}

type UpdateState =
  | { kind: "idle" | "checking" | "latest" | "updated" }
  | { kind: "available"; latest: string; updateLink?: string }
  | { kind: "updating"; latest: string; progress: number | null }
  | { kind: "error"; message: string };

/** The Memory pane in Zotero's settings: options, batch backup, update check and changelog. */
export class PreferencePane {
  private readonly documents = new Set<Document>();
  private paneID?: string;
  private releases: ReleaseNote[] = [];
  private checkedAt = 0;
  private checking?: Promise<void>;
  private update: UpdateState = { kind: "idle" };
  private prefsRestoreQueued = false;

  constructor(private readonly host: PaneHost) {}

  async register(): Promise<void> {
    const panes = (Zotero as any).PreferencePanes;
    if (!panes?.register) return;
    try {
      this.paneID = await panes.register({
        pluginID: ADDON_ID,
        id: PANE_PREF_ID,
        label: ADDON_NAME,
        src: `chrome://${CHROME_PACKAGE}/content/preferences.xhtml`,
        image: `chrome://${CHROME_PACKAGE}/content/icons/icon.png`,
        stylesheets: [`chrome://${CHROME_PACKAGE}/content/preferences.css`],
      });
      // Prefs window reloads asynchronously; bind() also restores once the Memory pane is live.
      this.restorePrefsSelection();
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

    const ownerFromEvent = (event?: Event): Window => {
      const view = (event?.target as Node | null)?.ownerDocument?.defaultView;
      return view && !view.closed ? view : win;
    };
    const actions: Record<string, (event?: Event) => void> = {
      "batch-export": (event) => this.host.batchExportAnnotations(ownerFromEvent(event)),
      "batch-import": (event) => this.host.batchImportAnnotations(ownerFromEvent(event)),
      check: () => void this.check(true),
      install: () => void this.install(),
      changelog: () => this.toggleChangelog(root),
      "close-changelog": () => this.toggleChangelog(root, false),
    };
    root.querySelectorAll<HTMLElement>("[data-mem-action]").forEach((button) => {
      const action = actions[button.dataset.memAction ?? ""];
      if (action) button.addEventListener("click", (event) => action(event));
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
    // Pane DOM is ready now — best moment to leave General after an in-place update reload.
    this.restorePrefsSelection();
    // Always re-validate an "available" tip — a withdrawn release must not stick on the Install button.
    if (this.update.kind === "updating" || this.update.kind === "updated") {
      // leave alone
    } else if (this.update.kind === "available") {
      void this.check(true);
    } else if (Date.now() - this.checkedAt > RECHECK_AFTER_MS) {
      void this.check(false);
    }
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
    // Do not freeze on "available": a withdrawn release would keep offering a dead Install link.
    if (!force && (this.update.kind === "updated" || this.update.kind === "updating")) {
      return Promise.resolve();
    }
    this.setUpdate({ kind: "checking" });
    this.checking = (async () => {
      try {
        const result = await checkForUpdates();
        this.releases = result.releases;
        this.checkedAt = Date.now();
        // Only trust a remote answer for "up to date". Local changelog alone can be stale.
        if (result.remote && result.latest && compareVersions(result.latest, VERSION) > 0) {
          this.setUpdate({ kind: "available", latest: result.latest, updateLink: result.updateLink });
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

  private async install(): Promise<void> {
    // Refresh first so a deleted test release is not still offered.
    await this.check(true);
    if (this.update.kind !== "available") return;
    const latest = this.update.latest;
    const updateLink = this.update.updateLink;
    this.markReturnToPane();
    this.setUpdate({ kind: "updating", latest, progress: 0 });
    try {
      if (
        await installUpdate(updateLink, (fraction) => {
          if (this.update.kind !== "updating") return;
          const progress = typeof fraction === "number" && Number.isFinite(fraction) ? fraction : this.update.progress;
          this.setUpdate({ kind: "updating", latest, progress });
        })
      ) {
        this.setUpdate({ kind: "updated" });
        return;
      }
    } catch (error) {
      logError(error);
    }
    this.clearReturnToPane();
    this.setUpdate({ kind: "available", latest, updateLink });
    const release = this.releases.find((entry) => entry.version === latest);
    (Zotero as any).launchURL?.(release?.url ?? updateLink ?? RELEASES_PAGE);
  }

  /** Remember Memory as the prefs target across the AddonManager reload. */
  private markReturnToPane(): void {
    try {
      const paneID = this.paneID ?? PANE_PREF_ID;
      (Zotero as any).Prefs.set("lastSelectedPrefPane", paneID);
      (Zotero as any).Prefs.set(REOPEN_PREFS_KEY, this.prefsWindowOpen() ? "focus" : "remember", true);
    } catch (error) {
      logError(error);
    }
  }

  private clearReturnToPane(): void {
    try {
      (Zotero as any).Prefs.set(REOPEN_PREFS_KEY, false, true);
    } catch (error) {
      logError(error);
    }
  }

  private prefsWindowOpen(): boolean {
    try {
      const enumerator = (Services as any).wm?.getEnumerator?.("zotero:pref");
      return Boolean(enumerator?.hasMoreElements?.());
    } catch {
      return false;
    }
  }

  /**
   * After an update, PreferencePanes reloads prefs while Memory is briefly unregistered,
   * so Zotero falls back to General. Keep the reopen flag until navigation actually lands
   * on Memory — clearing it too early left users stuck on 常规.
   */
  private restorePrefsSelection(): void {
    const paneID = this.paneID ?? PANE_PREF_ID;
    let mode: unknown;
    try {
      mode = (Zotero as any).Prefs.get(REOPEN_PREFS_KEY, true);
    } catch {
      return;
    }
    if (!mode || mode === false || mode === "false") return;

    try {
      (Zotero as any).Prefs.set("lastSelectedPrefPane", paneID);
    } catch (error) {
      logError(error);
    }

    const wantFocus = mode === "focus" || mode === true;
    if (!wantFocus) {
      this.clearReturnToPane();
      return;
    }

    if (this.prefsRestoreQueued) return;
    this.prefsRestoreQueued = true;

    const attempt = (left: number): void => {
      let done = false;
      try {
        (Zotero as any).Prefs.set("lastSelectedPrefPane", paneID);
        const enumerator = (Services as any).wm?.getEnumerator?.("zotero:pref");
        while (enumerator?.hasMoreElements?.()) {
          const win = enumerator.getNext();
          const prefs = win?.Zotero_Preferences;
          if (!prefs) continue;
          if (typeof prefs.navigateToPane === "function") {
            void prefs.navigateToPane(paneID);
          }
          const selected = prefs.navigation?.value ?? prefs._navigation?.value;
          if (selected === paneID) done = true;
          else if (prefs.panes?.get?.(paneID) && prefs.navigation) {
            prefs.navigation.value = paneID;
            done = prefs.navigation.value === paneID;
          }
        }
        if (!done) {
          const open = (Zotero as any).Utilities?.Internal?.openPreferences;
          if (typeof open === "function") open.call((Zotero as any).Utilities.Internal, paneID);
        }
      } catch (error) {
        logError(error);
      }
      if (done) {
        this.prefsRestoreQueued = false;
        this.clearReturnToPane();
        return;
      }
      if (left > 0) {
        setTimeout(() => attempt(left - 1), 200);
        return;
      }
      this.prefsRestoreQueued = false;
      this.clearReturnToPane();
    };
    setTimeout(() => attempt(40), 0);
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
    const progress = root.querySelector<HTMLElement>("[data-mem-update-progress]");
    const bar = root.querySelector<HTMLElement>("[data-mem-update-progress-bar]");
    if (version) version.textContent = `v${VERSION}`;
    if (!status) return;
    const state = this.update;
    // When an update exists, only the Install control carries the new version — no extra status text.
    let statusText = "";
    if (state.kind === "checking") statusText = "检查中…";
    else if (state.kind === "updating") {
      const fraction = state.progress;
      statusText =
        typeof fraction === "number" && Number.isFinite(fraction)
          ? `正在安装… ${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
          : "正在安装…";
    } else if (state.kind === "updated") statusText = "已安装，请重启 Zotero";
    else if (state.kind === "error") statusText = state.message;
    status.textContent = statusText;
    status.dataset.state = state.kind;
    const latest = root.querySelector<HTMLElement>("[data-mem-update-latest]");
    if (latest) {
      if (state.kind === "latest") {
        latest.hidden = false;
        latest.removeAttribute("hidden");
      } else {
        latest.hidden = true;
        latest.setAttribute("hidden", "true");
      }
    }
    if (install) {
      const showInstall = state.kind === "available";
      install.textContent = showInstall ? `安装 v${state.latest}` : "安装";
      if (showInstall) {
        install.hidden = false;
        install.removeAttribute("hidden");
      } else {
        install.hidden = true;
        install.setAttribute("hidden", "true");
      }
    }
    if (check) {
      check.disabled = state.kind === "checking" || state.kind === "updating" || state.kind === "updated";
      check.classList.toggle("mem-spinning", state.kind === "checking");
    }
    if (progress && bar) {
      const showing = state.kind === "updating";
      if (showing) {
        progress.removeAttribute("hidden");
        progress.hidden = false;
      } else {
        progress.setAttribute("hidden", "true");
        progress.hidden = true;
      }
      progress.setAttribute("aria-hidden", String(!showing));
      if (showing) {
        const fraction = state.progress;
        const determinate = typeof fraction === "number" && Number.isFinite(fraction);
        progress.dataset.indeterminate = determinate ? "false" : "true";
        bar.style.width = determinate ? `${Math.max(0, Math.min(1, fraction)) * 100}%` : "";
      } else {
        delete progress.dataset.indeterminate;
        bar.style.width = "";
      }
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
    if (show && !this.releases.length && this.update.kind !== "updated") void this.check(true);
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
      if (order === 0) head.append(make("span", "mem-badge mem-badge-current", "NOW"));
      else if (order > 0) head.append(make("span", "mem-badge mem-badge-new", "NEW"));
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
