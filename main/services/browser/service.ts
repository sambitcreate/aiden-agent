import {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  shell,
  dialog,
  nativeImage,
  type Session,
} from "electron";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { buildBrowserAnnotationPreviewApplyExpression, buildBrowserAnnotationPreviewResetExpression } from "./annotation-preview.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import type {
  BrowserAnnotation,
  BrowserAgentAccessOverride,
  BrowserBounds,
  BrowserCommand,
  BrowserCommandResult,
  BrowserDefaults,
  BrowserDiagnostic,
  BrowserElement,
  BrowserEvent,
  BrowserImage,
  BrowserProfile,
  BrowserRecording,
  BrowserSnapshot,
  BrowserStylePreview,
  BrowserState,
  BrowserTab,
} from "../../../renderer/shared/browser.js";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  resolveBrowserAgentAccess,
} from "../../../renderer/shared/browser.js";
import {
  browserAbort,
  browserBoundedNumber,
  browserDeadline,
  browserPartition,
  browserResult,
  browserUrl,
  browserDisplayUrl,
  browserRedactPreviewUrls,
  browserPageCaptureBounds,
  browserLocalServers,
  BrowserActionQueue,
  BROWSER_MAX_TABS,
} from "./core.js";
import { playwrightInjectedSource } from "./playwright-source.generated.js";
import { browserImportSources, importBrowserCookies } from "./import.js";
import { browserFileService, browserPreviewRequestHeaders, type BrowserFileReservation, type PreparedBrowserFile } from "./files.js";
import type { BrowserApprovalTarget } from "./approval.js";
import { configureBrowserPermissionHandlers } from "./permission-policy.js";
import { configStore } from "../config-store.js";

type CommandContext = {
  owner?: RendererDocumentOwner;
  signal?: AbortSignal;
  source: "user" | "agent";
  supportsImages?: boolean;
  preparedFile?: PreparedBrowserFile;
  beforeEffect?: () => void;
};
interface WorkspaceBrowser {
  state: BrowserState;
  owner?: RendererDocumentOwner;
  removeOwner?: () => void;
}
interface RecordingSession {
  id: string;
  started: number;
  recorder: BrowserWindow;
  stopTimer: ReturnType<typeof setTimeout>;
  pending: Promise<unknown>;
  failed?: string;
  busy?: boolean;
}
interface LiveTab {
  state: BrowserTab;
  view: WebContentsView;
  queue: BrowserActionQueue;
  diagnostics: BrowserDiagnostic[];
  network: Array<Record<string, unknown>>;
  timeline: Array<Record<string, unknown>>;
  contextId?: number;
  refs: Map<string, string>;
  referenceGeneration: number;
  attached?: BrowserWindow;
  floatingViewport?: BrowserTab["viewport"];
  pip?: BrowserWindow;
  pipTimer?: ReturnType<typeof setInterval>;
  recording?: RecordingSession;
  pendingRecorder?: BrowserWindow;
  visible: boolean;
  bounds?: BrowserBounds;
  closing: boolean;
  expectedInputs: Array<{ type: string; key?: string; button?: string; modifiers?: number; expires: number }>;
  picking?: boolean;
  crashTimes: number[];
  crashTimer?: ReturnType<typeof setTimeout>;
  navigationSequence: number;
  committedNavigation: number;
  lastCursor?: { x: number; y: number };
  previewNavigation?: BrowserFileReservation;
  initialLoad?: Promise<void>;
}

const ACTIONS_AGENT = new Set([
  "create",
  "open_file",
  "select",
  "navigate",
  "viewport",
  "appearance",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "wait",
  "record_start",
  "record_stop",
]);
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const RECORDING_MAX_BYTES = 128 * 1024 * 1024;
const PLAYWRIGHT_OPTIONS = {
  isUnderTest: false,
  sdkLanguage: "javascript",
  testIdAttributeName: "data-testid",
  stableRafCount: 1,
  browserName: "chromium",
  shouldPrependErrorPrefix: false,
  isUtilityWorld: true,
  customEngines: [],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}
function redactBrowserData<T>(value: T): T {
  const imagePaths = new Set(["image.data", "snapshot.image.data", "annotation.image.data"]);
  const visit = (item: unknown, at: string): unknown => {
    if (typeof item === "string") return imagePaths.has(at) ? item : browserFileService.redactText(item);
    if (Array.isArray(item)) return item.map((entry, index) => visit(entry, `${at}.${index}`));
    if (item && typeof item === "object") {
      const keys = new Set<string>();
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
        const base = browserFileService.redactText(key);
        let safeKey = base;
        for (let suffix = 2; keys.has(safeKey); suffix += 1) safeKey = `${base} (${suffix})`;
        keys.add(safeKey);
        return [safeKey, visit(entry, at ? `${at}.${key}` : key)];
      }));
    }
    return item;
  };
  return visit(value, "") as T;
}
function text(value: unknown, label: string, max = 64_000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function profileName(value: unknown): string {
  const name = text(value, "profile name", 48).trim();
  if (!name) throw new Error("Enter a profile name.");
  return name;
}
function boundedBounds(value: BrowserBounds): BrowserBounds {
  return {
    x: Math.round(browserBoundedNumber(value.x, -20_000, 20_000, "X")),
    y: Math.round(browserBoundedNumber(value.y, -20_000, 20_000, "Y")),
    width: Math.round(browserBoundedNumber(value.width, 1, 8_192, "Width")),
    height: Math.round(browserBoundedNumber(value.height, 1, 8_192, "Height")),
  };
}

/** Main owns every guest. Untrusted websites never receive Aiden's preload or IPC. */
export class BrowserService {
  private readonly workspaces = new Map<string, WorkspaceBrowser>();
  private readonly tabs = new Map<string, LiveTab>();
  private readonly popupOwners = new Map<number, { workspaceId: string; ownerDocumentId: string }>();
  private readonly sessions = new Map<string, Session>();
  private readonly recordings = new Map<string, BrowserRecording>();
  private readonly terminalTails = new Map<string, string>();
  private readonly agentFileAcquisitions = new Map<string, Set<AbortController>>();
  private profiles: BrowserProfile[] = clone(BUILT_IN_BROWSER_PROFILES);
  private readonly deletingProfiles = new Set<string>();
  private defaults: BrowserDefaults = clone(DEFAULT_BROWSER_SETTINGS);
  private readonly workspaceAccess = new Map<string, BrowserAgentAccessOverride>();
  private loaded = false;
  private incognitoGeneration = randomUUID();
  private persistence: Promise<unknown> = Promise.resolve();

  private storagePath(): string {
    return path.join(app.getPath("userData"), "browser", "state.json");
  }
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved = JSON.parse(readFileSync(this.storagePath(), "utf8"));
      if (Array.isArray(saved.profiles))
        for (const p of saved.profiles.slice(0, 24)) {
          if (
            typeof p.id === "string" &&
            /^profile-[a-z\d-]+$/i.test(p.id) &&
            typeof p.name === "string"
          )
            this.profiles.push({ id: p.id, name: profileName(p.name), kind: "persistent" });
        }
      if (saved.defaults && typeof saved.defaults === "object")
        this.defaults = this.validDefaults(saved.defaults);
      if (saved.workspaceAccess && typeof saved.workspaceAccess === "object")
        for (const [id, access] of Object.entries(saved.workspaceAccess).slice(0, 1000)) {
          if (id.length > 0 && id.length <= 200 && (access === "allow" || access === "off"))
            this.workspaceAccess.set(id, access);
        }
    } catch {
      /* A corrupt or absent browser preference file does not block browsing. */
    }
  }
  private save(): void {
    const target = this.storagePath();
    const json = JSON.stringify({
      profiles: this.profiles.filter((p) => p.id.startsWith("profile-")),
      defaults: this.defaults,
      workspaceAccess: Object.fromEntries(this.workspaceAccess),
    });
    this.persistence = this.persistence
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, json, { mode: 0o600 });
        await fs.rename(temporary, target);
      })
      .catch(() => {});
  }
  private workspace(id: string): WorkspaceBrowser {
    this.load();
    text(id, "workspace ID", 200);
    if (!id) throw new Error("A workspace is required for the browser.");
    let workspace = this.workspaces.get(id);
    if (!workspace) {
      workspace = {
        state: {
          workspaceId: id,
          revision: 0,
          tabs: [],
          activeTabId: null,
          profiles: this.profiles,
          defaults: this.defaults,
          agentAccessOverride: this.workspaceAccess.get(id) ?? "inherit",
          agentAccessAllowed: resolveBrowserAgentAccess(
            this.defaults.agentAccess,
            this.workspaceAccess.get(id) ?? "inherit",
          ),
          history: [],
          servers: [],
        },
      };
      this.workspaces.set(id, workspace);
    }
    return workspace;
  }
  attachOwner(workspaceId: string, owner: RendererDocumentOwner): void {
    const workspace = this.workspace(workspaceId);
    if (owner.isDestroyed())
      throw new Error("The browser's application document is no longer active.");
    if (workspace.owner?.documentId === owner.documentId && workspace.owner.id === owner.id) return;
    if (workspace.owner && !workspace.owner.isDestroyed())
      throw new Error("This workspace browser belongs to another application window.");
    workspace.removeOwner?.();
    workspace.owner = owner;
    workspace.removeOwner = owner.onInvalidated(() => this.closeForWebContents(owner.id));
  }
  getState(workspaceId: string): BrowserState {
    const workspace = this.workspace(workspaceId);
    workspace.state.profiles = this.profiles;
    workspace.state.defaults = this.defaults;
    workspace.state.agentAccessOverride = this.workspaceAccess.get(workspaceId) ?? "inherit";
    workspace.state.agentAccessAllowed = resolveBrowserAgentAccess(
      this.defaults.agentAccess,
      workspace.state.agentAccessOverride,
    );
    return redactBrowserData(clone(workspace.state));
  }
  getApprovalTarget(workspaceId: string, tabId?: string): BrowserApprovalTarget {
    this.mainWindow(workspaceId);
    const selected = tabId ?? this.workspace(workspaceId).state.activeTabId;
    if (!selected) throw new Error("Open a browser tab before reviewing this action.");
    const tab = this.tab(workspaceId, selected);
    return { workspaceId, tabId: selected, url: tab.state.url,
      documentRevision: `${tab.navigationSequence}:${tab.committedNavigation}`, controlRevision: tab.queue.epoch };
  }
  private beginPreviewNavigation(tab: LiveTab, url: string): void {
    const next = browserFileService.reserveUrl(tab.state.workspaceId, url);
    tab.previewNavigation?.release();
    tab.previewNavigation = next;
  }
  private finishPreviewNavigation(tab: LiveTab): void {
    const pending = tab.previewNavigation;
    tab.previewNavigation = undefined;
    pending?.release();
  }
  private cancelFileAcquisitions(workspaceId: string): void {
    for (const controller of this.agentFileAcquisitions.get(workspaceId) ?? [])
      controller.abort(new Error("Agent browser file access was revoked."));
    this.agentFileAcquisitions.delete(workspaceId);
  }
  observeTerminalOutput(workspaceId: string, data: string): void {
    const tail = ((this.terminalTails.get(workspaceId) ?? "") + data).slice(-8_192);
    this.terminalTails.set(workspaceId, tail);
    if (this.terminalTails.size > 100)
      this.terminalTails.delete(this.terminalTails.keys().next().value!);
    const servers = browserLocalServers(tail);
    if (!servers.length) return;
    const workspace = this.workspace(workspaceId);
    const next = [...servers, ...workspace.state.servers]
      .filter(
        (server, index, all) =>
          all.findIndex((candidate) => candidate.url === server.url) === index,
      )
      .slice(0, 12);
    if (JSON.stringify(workspace.state.servers) !== JSON.stringify(next)) {
      workspace.state.servers = next;
      this.emit(workspaceId);
    }
  }
  private emit(workspaceId: string, event?: BrowserEvent): void {
    const workspace = this.workspace(workspaceId);
    workspace.state.revision += 1;
    if (workspace.owner && !workspace.owner.isDestroyed()) {
      try {
        workspace.owner.send(
          "browser:event",
          redactBrowserData(event ?? { type: "state", state: this.getState(workspaceId) }),
        );
      } catch {
        /* Document invalidation revokes delivery. */
      }
    }
  }
  private emitAll(): void {
    for (const id of this.workspaces.keys()) this.emit(id);
  }
  private tab(workspaceId: string, id: string): LiveTab {
    const tab = this.tabs.get(text(id, "browser tab ID", 200));
    if (
      !tab ||
      tab.state.workspaceId !== workspaceId ||
      tab.closing ||
      tab.view.webContents.isDestroyed()
    )
      throw new Error("The requested browser tab is no longer available in this workspace.");
    return tab;
  }
  private profile(id: string): BrowserProfile {
    if (this.deletingProfiles.has(id)) throw new Error("This browser profile is being deleted.");
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw new Error("This browser profile no longer exists.");
    return profile;
  }
  private browserSession(profileId: string): Session {
    const profile = this.profile(profileId);
    const partition = browserPartition(
      profile.kind === "incognito" ? `${profile.id}:${this.incognitoGeneration}` : profile.id,
      profile.kind === "incognito",
    );
    let browserSession = this.sessions.get(partition);
    if (!browserSession) {
      browserSession = session.fromPartition(partition);
      browserSession.setUserAgent(
        browserSession
          .getUserAgent()
          .replace(/\s*Electron\/[\d.]+/g, "")
          .replace(/\s*aiden[^\s]*\/[\d.]+/gi, ""),
      );
      configureBrowserPermissionHandlers(browserSession, (contents) => {
        if (!contents || contents.isDestroyed()) return undefined;
        const owned = [...this.tabs.values()].some(
          (tab) => !tab.closing && tab.view.webContents === contents,
        );
        return owned ? contents.getURL() : undefined;
      });
      browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
        let authorization: string | undefined;
        try {
          const contents = details.webContents;
          if (contents && !contents.isDestroyed() && details.frame) {
            const tab = [...this.tabs.values()].find((candidate) =>
              !candidate.closing && candidate.view.webContents === contents,
            );
            const popup = this.popupOwners.get(contents.id);
            const workspaceId = tab?.state.workspaceId ?? popup?.workspaceId;
            const owner = workspaceId ? this.workspaces.get(workspaceId)?.owner : undefined;
            if (workspaceId && owner && !owner.isDestroyed() &&
              (tab || popup?.ownerDocumentId === owner.documentId)) {
              // Use the committed frame's security origin, including inherited
              // about:blank origins; the destination URL never supplies authority.
              authorization = browserFileService.authorizationForRequest(
                workspaceId, details.url, details.frame.origin,
              );
            }
          }
        } catch {
          // Navigation/disposal can invalidate frame handles synchronously.
        }
        callback({ requestHeaders: browserPreviewRequestHeaders(details.requestHeaders, authorization) });
      });
      browserSession.on("will-download", (_event, item, wc) => {
        if (![...this.tabs.values()].some((t) => t.view.webContents === wc)) {
          item.cancel();
          return;
        }
        // Chromium's native Save dialog remains the user authority for downloaded files.
        item.setSaveDialogOptions({
          defaultPath: path.join(app.getPath("downloads"), path.basename(item.getFilename())),
        });
      });
      this.sessions.set(partition, browserSession);
    }
    return browserSession;
  }
  private mainWindow(workspaceId: string): BrowserWindow {
    const owner = this.workspace(workspaceId).owner;
    if (!owner || owner.isDestroyed())
      throw new Error("Open this workspace in Aiden before using its browser.");
    const window = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && w.webContents.id === owner.id,
    );
    if (!window) throw new Error("The browser's application window is unavailable.");
    return window;
  }
  private observe(tab: LiveTab): void {
    const wc = tab.view.webContents;
    const publish = () => {
      if (tab.closing || wc.isDestroyed()) return;
      Object.assign(tab.state, {
        url: browserDisplayUrl(wc.getURL() || "about:blank"),
        title: wc.getTitle() || "New tab",
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        audible: wc.isCurrentlyAudible(),
        muted: wc.isAudioMuted(),
      });
      this.emit(tab.state.workspaceId);
    };
    wc.on("did-start-loading", publish);
    wc.on("did-stop-loading", publish);
    wc.on("did-stop-loading", () => this.finishPreviewNavigation(tab));
    wc.on("page-title-updated", publish);
    wc.on("media-started-playing", publish);
    wc.on("media-paused", publish);
    wc.on("audio-state-changed", publish);
    wc.on("did-navigate", () => {
      browserFileService.commitConsumer(tab.state.workspaceId, tab.state.id, wc.getURL());
      this.finishPreviewNavigation(tab);
      tab.committedNavigation += 1;
      tab.contextId = undefined;
      tab.refs.clear();
      tab.referenceGeneration += 1;
      tab.state.error = undefined;
      tab.state.crashed = false;
      publish();
      if (
        !tab.closing &&
        this.profiles.find((profile) => profile.id === tab.state.profileId)?.kind !== "incognito" &&
        /^https?:/.test(wc.getURL()) &&
        !browserFileService.isPreviewUrl(wc.getURL())
      ) {
        const history = this.workspace(tab.state.workspaceId).state.history;
        this.workspace(tab.state.workspaceId).state.history = [
          { url: wc.getURL(), title: wc.getTitle() || wc.getURL(), visitedAt: Date.now() },
          ...history.filter((h) => h.url !== wc.getURL()),
        ].slice(0, 10);
        this.emit(tab.state.workspaceId);
      }
    });
    wc.on("did-navigate-in-page", () => {
      browserFileService.commitConsumer(tab.state.workspaceId, tab.state.id, wc.getURL());
      this.finishPreviewNavigation(tab);
      tab.committedNavigation += 1;
      publish();
    });
    wc.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        try { this.beginPreviewNavigation(tab, url); } catch (error) { wc.stop(); this.finishPreviewNavigation(tab); tab.state.error = String(error); }
        tab.navigationSequence += 1;
        tab.contextId = undefined;
        tab.refs.clear();
      }
    });
    wc.on("will-navigate", (event, url) => {
      try {
        browserUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    wc.on("will-redirect", (event, url) => {
      try {
        browserUrl(url);
      } catch {
        event.preventDefault();
      }
    });
    wc.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        tab.state.error = description;
        tab.state.loading = false;
        this.emit(tab.state.workspaceId);
      }
    });
    wc.on("render-process-gone", (_event, details) => {
      tab.queue.interrupt();
      tab.contextId = undefined;
      tab.state.crashed = true;
      tab.state.loading = false;
      tab.crashTimes = tab.crashTimes.filter((time) => Date.now() - time < 30_000);
      tab.crashTimes.push(Date.now());
      if (tab.crashTimes.length <= 3) {
        tab.state.error = "The page crashed. Restoring it…";
        tab.crashTimer = setTimeout(
          () => {
            if (!tab.closing && !wc.isDestroyed()) {
              tab.state.crashed = false;
              tab.state.error = undefined;
              wc.reload();
            }
          },
          [300, 1000, 2000][tab.crashTimes.length - 1],
        );
      } else tab.state.error = `Page process ${details.reason} repeatedly. Reload to recover.`;
      this.emit(tab.state.workspaceId);
    });
    wc.setIgnoreMenuShortcuts(true);
    const humanInput = (type: string, key?: string, modifiers?: number, button?: string, nativeModifiers?: number) => {
      if (tab.picking) return true;
      tab.expectedInputs = tab.expectedInputs.filter((expected) => expected.expires > Date.now());
      // Pinned Electron 43.1.1 keyboard/generic converter exposes _modifiers:
      // https://github.com/electron/electron/blob/v43.1.1/shell/common/gin_converters/blink_converter.cc
      // Blink's WebInputEvent::kFromDebugger = 1 << 23 identifies injected input:
      // https://github.com/chromium/chromium/blob/main/third_party/blink/public/common/input/web_input_event.h
      // Keyboard metadata must be present; missing flags fail closed on upgrade.
      // Electron's specialized mouse converter omits the flags, so those events
      // still require bounded matching and cannot identify an exact collision.
      const fromDebugger = Number.isSafeInteger(nativeModifiers) && ((nativeModifiers! & (1 << 23)) !== 0);
      const mayMatch = fromDebugger || (key === undefined && nativeModifiers === undefined);
      const index = mayMatch ? tab.expectedInputs.findIndex(
        (expected) =>
          expected.type === type && (expected.key === undefined || expected.key === key) &&
          (expected.modifiers === undefined || expected.modifiers === modifiers) &&
          (expected.button === undefined || expected.button === button),
      ) : -1;
      if (index >= 0) {
        tab.expectedInputs.splice(index, 1);
        return true;
      }
      tab.queue.interrupt();
      return false;
    };
    wc.on("before-input-event", (event, input) => {
      // A repeated physical key is still user control; only debugger-marked
      // echoes may consume expectations, regardless of auto-repeat.
      const modifiers = Number(input.alt) | (Number(input.control) << 1) | (Number(input.meta) << 2) | (Number(input.shift) << 3);
      const synthetic = humanInput(input.type, input.key, modifiers, undefined, (input as typeof input & { _modifiers?: number })._modifiers);
      if (synthetic || input.type !== "keyDown" || !(input.meta || input.control) || input.alt)
        return;
      const key = input.key.toLowerCase();
      const shortcut =
        key === "."
          ? "annotate"
          : key === "l"
            ? "focus_address"
            : key === "r"
              ? input.shift
                ? "hard_reload"
                : "reload"
              : null;
      if (shortcut) {
        event.preventDefault();
        this.emit(tab.state.workspaceId, {
          type: "shortcut",
          workspaceId: tab.state.workspaceId,
          tabId: tab.state.id,
          shortcut,
        });
      }
    });
    wc.on("before-mouse-event", (_event, input) => {
      if (input.type !== "mouseMove" && input.type !== "mouseEnter" && input.type !== "mouseLeave")
        humanInput(input.type, undefined, undefined, input.button, (input as typeof input & { _modifiers?: number })._modifiers);
    });
    wc.on("console-message", (details) => {
      tab.diagnostics.push({
        level: details.level,
        message: browserFileService.redactText(details.message).slice(0, 4_000),
        timestamp: Date.now(),
      });
      tab.diagnostics = tab.diagnostics.slice(-200);
    });
    wc.on("page-favicon-updated", (_event, urls) => {
      const candidate = urls.find((url) => /^https?:\/\//.test(url) || /^data:image\//.test(url));
      if (candidate && candidate.length < 32_000) {
        tab.state.favicon = candidate;
        this.emit(tab.state.workspaceId);
      }
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      try {
        browserUrl(url);
      } catch {
        return { action: "deny" };
      }
      // Feature-bearing windows are OAuth/popups: retain Chromium's opener and session.
      if (disposition === "new-window" && /^https?:/.test(url))
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 640,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: {
              session: wc.session,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              webSecurity: true,
              preload: undefined,
            },
          },
        };
      if (this.defaults.linkTarget === "external") void shell.openExternal(url);
      else void wc.loadURL(url).catch(() => {});
      return { action: "deny" };
    });
    wc.on("did-create-window", (window, details) => {
      const consumerId = `browser-popup:${window.webContents.id}`;
      const owner = this.workspaces.get(tab.state.workspaceId)?.owner;
      if (!owner || owner.isDestroyed()) { window.destroy(); return; }
      this.popupOwners.set(window.webContents.id, {
        workspaceId: tab.state.workspaceId, ownerDocumentId: owner.documentId,
      });
      const popupId = window.webContents.id;
      window.once("closed", () => { this.popupOwners.delete(popupId); });
      let pending: BrowserFileReservation | undefined;
      try { pending = browserFileService.reserveUrl(tab.state.workspaceId, details.url); } catch { window.destroy(); return; }
      const releasePending = () => { const value = pending; pending = undefined; value?.release(); };
      window.webContents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
        if (!mainFrame || inPlace) return;
        try {
          const next = browserFileService.reserveUrl(tab.state.workspaceId, url);
          releasePending(); pending = next;
        } catch { window.webContents.stop(); releasePending(); }
      });
      window.webContents.on("did-navigate", () => {
        browserFileService.commitConsumer(tab.state.workspaceId, consumerId, window.webContents.getURL());
        releasePending();
      });
      window.webContents.on("did-stop-loading", releasePending);
      window.once("closed", () => { releasePending(); browserFileService.releaseConsumer(consumerId); });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        try {
          browserUrl(url);
        } catch {
          event.preventDefault();
        }
      });
      window.webContents.on("will-redirect", (event, url) => {
        try {
          browserUrl(url);
        } catch {
          event.preventDefault();
        }
      });
      wc.once("destroyed", () => {
        if (!window.isDestroyed()) window.destroy();
      });
    });
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Network.responseReceived") {
        const response = params.response;
        tab.network.push({
          url: browserDisplayUrl(String(response?.url ?? "")).slice(0, 4_000),
          status: response?.status,
          mimeType: response?.mimeType,
          timestamp: Date.now(),
        });
        tab.network = tab.network.slice(-200);
      }
      if (method === "Page.screencastFrame") this.recordFrame(tab, params);
    });
    wc.on("destroyed", () => {
      if (!tab.closing) this.close(tab);
    });
  }
  private async create(
    workspaceId: string,
    url = "about:blank",
    profileId = this.defaults.profileId,
    show = true,
  ): Promise<LiveTab> {
    const workspace = this.workspace(workspaceId);
    this.mainWindow(workspaceId);
    if (workspace.state.tabs.length >= BROWSER_MAX_TABS)
      throw new Error(`Close a browser tab before opening more than ${BROWSER_MAX_TABS}.`);
    const normalized = browserUrl(url);
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession(profileId),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    const state: BrowserTab = {
      id: `browser-${randomUUID()}`,
      workspaceId,
      profileId,
      url: browserDisplayUrl(normalized),
      title: "New tab",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      audible: false,
      muted: false,
      viewport: clone(this.defaults.viewport),
      appearance: this.defaults.appearance,
      zoom: this.defaults.zoom,
      recording: false,
      agentControlling: false,
      floating: false,
    };
    const tab: LiveTab = {
      state,
      view,
      queue: new BrowserActionQueue(),
      diagnostics: [],
      network: [],
      timeline: [],
      refs: new Map(),
      referenceGeneration: 0,
      visible: false,
      closing: false,
      expectedInputs: [],
      crashTimes: [],
      navigationSequence: 0,
      committedNavigation: 0,
    };
    this.tabs.set(state.id, tab);
    workspace.state.tabs.push(state);
    if (show) this.activateTab(tab);
    view.setBounds({ x: 0, y: 0, width: state.viewport.width, height: state.viewport.height });
    this.observe(tab);
    view.webContents.setZoomFactor(state.zoom);
    this.emit(workspaceId);
    if (show && !tab.state.floating) this.emit(workspaceId, { type: "show", workspaceId, tabId: state.id });
    try { this.beginPreviewNavigation(tab, normalized); } catch (error) { this.close(tab); throw error; }
    tab.initialLoad = view.webContents
      .loadURL(normalized)
      .then(() => {
        if (!tab.closing && view.webContents.getURL() === normalized)
          return this.applyEmulation(tab);
      })
      .catch((error) => {
        if (
          !tab.closing &&
          !String(error).includes("ERR_ABORTED") &&
          (view.webContents.getURL() === normalized || view.webContents.getURL() === "")
        ) {
          state.error = String(error);
          this.emit(workspaceId);
        }
        throw error;
      });
    void tab.initialLoad.catch(() => {});
    return tab;
  }
  private detach(tab: LiveTab): void {
    if (tab.attached && !tab.attached.isDestroyed()) {
      try {
        tab.attached.contentView.removeChildView(tab.view);
      } catch {
        /* Already removed. */
      }
    }
    tab.attached = undefined;
  }
  private present(tab: LiveTab, visible: boolean, bounds?: BrowserBounds): void {
    tab.visible = visible;
    tab.state.visible = visible;
    if (bounds) tab.bounds = boundedBounds(bounds);
    this.detach(tab);
    if (!visible || !tab.bounds) return;
    const window = this.mainWindow(tab.state.workspaceId);
    for (const candidate of this.tabs.values())
      if (candidate !== tab && candidate.attached === window) {
        this.detach(candidate);
        candidate.visible = false;
      }
    const scale = window.webContents.getZoomFactor();
    const area = window.getContentBounds();
    const b = tab.bounds;
    const x = Math.max(0, Math.round(b.x * scale));
    const y = Math.max(0, Math.round(b.y * scale));
    const width = Math.max(1, Math.min(Math.round(b.width * scale), area.width - x));
    const height = Math.max(1, Math.min(Math.round(b.height * scale), area.height - y));
    tab.view.setBounds({ x, y, width, height });
    window.contentView.addChildView(tab.view);
    tab.attached = window;
    void this.applyEmulation(tab).catch(() => {});
  }
  private close(tab: LiveTab): void {
    if (tab.closing) return;
    tab.closing = true;
    this.finishPreviewNavigation(tab);
    browserFileService.releaseConsumer(tab.state.id);
    tab.queue.interrupt();
    this.detach(tab);
    if (tab.pipTimer) clearInterval(tab.pipTimer);
    if (tab.crashTimer) clearTimeout(tab.crashTimer);
    if (tab.pip && !tab.pip.isDestroyed()) tab.pip.destroy();
    if (tab.recording) {
      clearTimeout(tab.recording.stopTimer);
      if (!tab.recording.recorder.isDestroyed()) tab.recording.recorder.destroy();
    }
    if (tab.pendingRecorder && !tab.pendingRecorder.isDestroyed()) tab.pendingRecorder.destroy();
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) {
      if (wc.debugger.isAttached()) wc.debugger.detach();
      wc.close({ waitForBeforeUnload: false });
    }
    this.tabs.delete(tab.state.id);
    const workspace = this.workspaces.get(tab.state.workspaceId);
    if (workspace) {
      workspace.state.tabs = workspace.state.tabs.filter((t) => t.id !== tab.state.id);
      if (workspace.state.activeTabId === tab.state.id) {
        workspace.state.activeTabId = workspace.state.tabs[workspace.state.tabs.length - 1]?.id ?? null;
        const replacement = workspace.state.activeTabId ? this.tabs.get(workspace.state.activeTabId) : undefined;
        if (tab.state.floating && replacement) this.floating(replacement, true, false);
      }
      this.emit(tab.state.workspaceId);
    }
    if (
      this.profile(tab.state.profileId).kind === "incognito" &&
      ![...this.tabs.values()].some((t) => t.state.profileId === tab.state.profileId)
    ) {
      const partition = browserPartition(
        `${tab.state.profileId}:${this.incognitoGeneration}`,
        true,
      );
      const privateSession = this.sessions.get(partition);
      this.sessions.delete(partition);
      this.incognitoGeneration = randomUUID();
      void privateSession?.clearStorageData().catch(() => {});
      void privateSession?.clearCache().catch(() => {});
    }
  }
  closeForWebContents(id: number): void {
    for (const [workspaceId, workspace] of this.workspaces)
      if (workspace.owner?.id === id) {
        this.cancelFileAcquisitions(workspaceId);
        for (const tab of [...this.tabs.values()])
          if (tab.state.workspaceId === workspaceId) this.close(tab);
        workspace.removeOwner?.();
        workspace.removeOwner = undefined;
        workspace.owner = undefined;
        void browserFileService.closeForWorkspace(workspaceId).catch(() => {});
      }
  }
  closeForWorkspace(workspaceId: string): void {
    this.cancelFileAcquisitions(workspaceId);
    for (const tab of [...this.tabs.values()])
      if (tab.state.workspaceId === workspaceId) this.close(tab);
    const workspace = this.workspaces.get(workspaceId);
    workspace?.removeOwner?.();
    this.workspaces.delete(workspaceId);
    this.terminalTails.delete(workspaceId);
    void browserFileService.closeForWorkspace(workspaceId).catch(() => {});
  }
  async shutdown(): Promise<void> {
    for (const workspaceId of this.agentFileAcquisitions.keys()) this.cancelFileAcquisitions(workspaceId);
    for (const tab of [...this.tabs.values()]) this.close(tab);
    await this.persistence;
    await browserFileService.shutdown();
  }

  private async send(
    tab: LiveTab,
    method: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<any> {
    const cleanup =
      (method === "Input.dispatchKeyEvent" && params.type === "keyUp") ||
      (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") ||
      method === "Page.stopScreencast";
    const signals = cleanup
      ? []
      : [signal, tab.queue.signal].filter((candidate): candidate is AbortSignal =>
          Boolean(candidate),
        );
    const effectiveSignal = signals.length ? AbortSignal.any(signals) : undefined;
    browserAbort(effectiveSignal);
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) throw new Error("The browser tab was closed.");
    if (wc.isDevToolsOpened())
      throw new Error("Close this tab's DevTools before using browser automation.");
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach("1.3");
      await wc.debugger.sendCommand("Network.enable");
    }
    // Keyboard/generic echoes require Blink's debugger marker; specialized
    // mouse events use bounded matching. No exemption outlives pending dispatch.
    const expected: LiveTab["expectedInputs"][number] | undefined = method === "Input.dispatchKeyEvent"
      ? { type: String(params.type), key: String(params.key), modifiers: Number(params.modifiers ?? 0), expires: Date.now() + 500 }
      : method === "Input.dispatchMouseEvent" && params.type !== "mouseMoved"
        ? { type: params.type === "mousePressed" ? "mouseDown" : params.type === "mouseReleased" ? "mouseUp" : String(params.type),
            ...(params.type === "mousePressed" || params.type === "mouseReleased" ? { button: String(params.button ?? "left") } : {}), expires: Date.now() + 500 }
        : undefined;
    if (expected) tab.expectedInputs.push(expected);
    try {
      return await browserDeadline(
        wc.debugger.sendCommand(method, params),
        15_000,
        effectiveSignal,
      );
    } catch (error) {
      if (
        (effectiveSignal?.aborted ||
          (error instanceof Error && /timed out/i.test(error.message))) &&
        method === "Runtime.evaluate" &&
        wc.debugger.isAttached()
      )
        void wc.debugger.sendCommand("Runtime.terminateExecution").catch(() => {});
      throw error;
    } finally {
      // Failed/no-echo dispatches must not leave a 500ms exemption for real input.
      if (expected) tab.expectedInputs = tab.expectedInputs.filter((entry) => entry !== expected);
    }
  }
  private async evaluate(
    tab: LiveTab,
    expression: string,
    signal?: AbortSignal,
    isolated = false,
    awaitPromise = true,
    returnByValue = true,
  ): Promise<any> {
    let contextId: number | undefined;
    if (isolated) {
      if (!tab.contextId) {
        const tree = await this.send(tab, "Page.getFrameTree", {}, signal);
        const world = await this.send(
          tab,
          "Page.createIsolatedWorld",
          {
            frameId: tree.frameTree.frame.id,
            worldName: "aiden-browser",
            grantUniveralAccess: false,
          },
          signal,
        );
        tab.contextId = world.executionContextId;
        await this.send(
          tab,
          "Runtime.evaluate",
          {
            expression: `(() => { const module = {exports:{}}; ${playwrightInjectedSource}\n globalThis.__aidenPlaywright = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(PLAYWRIGHT_OPTIONS)}); })()`,
            contextId: tab.contextId,
            returnByValue: true,
          },
          signal,
        );
      }
      contextId = tab.contextId;
    }
    const result = await this.send(
      tab,
      "Runtime.evaluate",
      { expression, contextId, awaitPromise, returnByValue, userGesture: true },
      signal,
    );
    if (result.exceptionDetails)
      throw new Error(
        String(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        ).slice(0, 4_000),
      );
    return returnByValue ? result.result?.value : result.result;
  }
  private presentationViewport(tab: LiveTab): BrowserTab["viewport"] {
    return tab.state.floating && tab.state.viewport.mode === "fill" && tab.floatingViewport
      ? tab.floatingViewport
      : tab.state.viewport;
  }
  private async applyEmulation(tab: LiveTab): Promise<void> {
    const viewport = this.presentationViewport(tab);
    if (viewport.mode === "responsive")
      await this.send(tab, "Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
        // The native slot owns the visible surface; emulation changes page layout
        // without resizing Chromium's compositor beyond the WebContentsView.
        dontSetVisibleSize: true,
        scale: Math.min(
          1,
          tab.view.getBounds().width / viewport.width,
          tab.view.getBounds().height / viewport.height,
        ),
      });
    else await this.send(tab, "Emulation.clearDeviceMetricsOverride");
    await this.send(tab, "Emulation.setEmulatedMedia", {
      features:
        tab.state.appearance === "system"
          ? []
          : [{ name: "prefers-color-scheme", value: tab.state.appearance }],
    });
    if (viewport.mode === "fill") {
      const measured = await this.evaluate(tab, "({width:innerWidth,height:innerHeight})");
      if (measured?.width > 0 && measured?.height > 0) {
        tab.state.viewport.width = measured.width;
        tab.state.viewport.height = measured.height;
      }
    }
  }
  private async capture(
    tab: LiveTab,
    fullPage = false,
    bounds?: BrowserBounds,
    signal?: AbortSignal,
  ): Promise<BrowserImage> {
    if (fullPage) {
      const metrics = await this.send(tab, "Page.getLayoutMetrics", {}, signal);
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size.width * size.height > 32_000_000)
        throw new Error("The full page is too large to capture. Capture the viewport or a region.");
      const screenshot = await this.send(
        tab,
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
        },
        signal,
      );
      return {
        data: screenshot.data,
        mimeType: "image/png",
        width: size.width,
        height: size.height,
      };
    }
    let failure: unknown;
    const pageBounds = browserPageCaptureBounds(
      tab.view.getBounds(),
      this.presentationViewport(tab),
    );
    let captureBounds = pageBounds;
    if (bounds) {
      const region = boundedBounds(bounds);
      const measured = await this.evaluate(tab, "({width:innerWidth,height:innerHeight})", signal);
      const scaleX = pageBounds.width / measured.width,
        scaleY = pageBounds.height / measured.height;
      captureBounds = {
        x: Math.max(0, Math.round(region.x * scaleX)),
        y: Math.max(0, Math.round(region.y * scaleY)),
        width: Math.round(region.width * scaleX),
        height: Math.round(region.height * scaleY),
      };
      captureBounds.width = Math.min(captureBounds.width, pageBounds.width - captureBounds.x);
      captureBounds.height = Math.min(captureBounds.height, pageBounds.height - captureBounds.y);
      if (captureBounds.width <= 0 || captureBounds.height <= 0)
        throw new Error("The capture region is outside the browser viewport.");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let image = await browserDeadline(
          tab.view.webContents.capturePage(captureBounds),
          1_200,
          signal,
        );
        if (image.isEmpty()) throw new Error("The browser page has not rendered yet.");
        if (!bounds && image.getSize().width > 1_280) image = image.resize({ width: 1_280 });
        const bytes = image.toPNG();
        if (bytes.length > MAX_CAPTURE_BYTES) throw new Error("Browser capture is too large.");
        return { data: bytes.toString("base64"), mimeType: "image/png", ...image.getSize() };
      } catch (error) {
        failure = error;
        browserAbort(signal);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    throw failure;
  }
  private async snapshot(
    tab: LiveTab,
    includeImage: boolean,
    signal?: AbortSignal,
    includeAllElements = false,
    preservedSelectors: BrowserStylePreview[] = [],
  ): Promise<BrowserSnapshot> {
    const generation = ++tab.referenceGeneration;
    const data = await this.evaluate(
      tab,
      `(() => {
      const visible = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"; };
      const all=[]; const walk=root=>{ for(const e of root.querySelectorAll("*")){ if((${includeAllElements ? "!e.matches('html,body,script,style,link,meta')" : "e.matches('a[href],button,input,textarea,select,[role],[tabindex]')"})&&visible(e)) all.push(e); if(e.shadowRoot) walk(e.shadowRoot); if(all.length>=200) break; } }; walk(document);
      globalThis.__aidenElements = all.slice(0,200);
      const preserved=${JSON.stringify(preservedSelectors.map(({ ref, selector }) => ({ ref, selector })))}.map(input=>({...input,element:globalThis.__aidenPlaywright.querySelector(globalThis.__aidenPlaywright.parseSelector(input.selector),document,false)}));
      const elements=globalThis.__aidenElements.map((e,i)=> { const r=e.getBoundingClientRect(); const original=preserved.find(input=>input.element===e);const selector=original?.selector??globalThis.__aidenPlaywright.generateSelectorSimple(e,{}); const attrs={}; for(const name of ['aria-label','placeholder','type','name','href','data-testid']) if(e.hasAttribute(name)) attrs[name]=e.getAttribute(name).slice(0,500); if(${includeAllElements}) {const style=getComputedStyle(e);for(const name of ['font-family','font-size','font-weight','line-height','color','background-color','opacity','border-radius','border-color','border-width','border-style','width','height','padding','margin','gap'])attrs['style:'+name]=style.getPropertyValue(name);} return {ref:original?.ref??${JSON.stringify(String(generation))}+'-'+i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||undefined,text:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').slice(0,500),selector,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},attributes:attrs}; });
      return {text:(document.body?.innerText||'').slice(0,20000),elements,width:innerWidth,height:innerHeight};
    })()`,
      signal,
      true,
    );
    tab.refs = new Map(
      (data.elements as BrowserElement[]).map((element, index) => [
        element.ref,
        `globalThis.__aidenElements?.[${index}]`,
      ]),
    );
    const snapshot: BrowserSnapshot = {
      tab: clone(tab.state),
      text: data.text,
      elements: data.elements,
      diagnostics: clone(tab.diagnostics),
    };
    snapshot.tab.viewport.width = data.width;
    snapshot.tab.viewport.height = data.height;
    if (includeImage) snapshot.image = await this.capture(tab, false, undefined, signal);
    const accessibilityTree = await this.send(tab, "Accessibility.getFullAXTree", {}, signal);
    Object.assign(snapshot, {
      accessibilityTree: { nodes: accessibilityTree.nodes?.slice(0, 1_000) },
      networkEntries: clone(tab.network),
      actionTimeline: clone(tab.timeline),
    });
    return browserRedactPreviewUrls(snapshot);
  }
  private target(
    tab: LiveTab,
    command: { ref?: string; selector?: string; locator?: string },
  ): string {
    if ([command.ref, command.selector, command.locator].filter((v) => v !== undefined).length > 1)
      throw new Error("Provide exactly one element reference, selector, or locator.");
    if (command.ref) {
      const ref = tab.refs.get(command.ref);
      if (!ref) throw new Error("This element reference is stale. Take a new snapshot.");
      return ref;
    }
    const locator = command.locator ?? command.selector;
    if (locator)
      return `globalThis.__aidenPlaywright.querySelector(globalThis.__aidenPlaywright.parseSelector(${JSON.stringify(text(locator, "selector", 4_000))}),document,true)`;
    return "document.activeElement";
  }
  private async elementPoint(
    tab: LiveTab,
    command: { ref?: string; selector?: string; locator?: string; timeoutMs?: number },
    signal?: AbortSignal,
    pinClickTarget = false,
  ): Promise<{ x: number; y: number }> {
    const target = this.target(tab, command);
    const end =
      Date.now() + browserBoundedNumber(command.timeoutMs ?? 15000, 1, 60000, "Action timeout");
    let failure: unknown;
    while (Date.now() < end) {
      browserAbort(signal);
      browserAbort(tab.queue.signal);
      try {
        return await this.evaluate(
          tab,
          `(() => { const e=${target}; if(!e||!e.isConnected) throw new Error('Element no longer exists; take a new snapshot.'); const injected=globalThis.__aidenPlaywright; if(!injected.elementState(e,'visible').matches||!injected.elementState(e,'enabled').matches) throw new Error('Element is hidden or disabled.'); e.scrollIntoView({block:'center',inline:'center'}); const r=e.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=injected.expectHitTarget({x,y},e); if(hit!=='done') throw new Error('Another element covers the target: '+(hit.hitTargetDescription||'')); ${pinClickTarget ? "globalThis.__aidenClickTarget=e;" : ""} return {x,y}; })()`,
          signal,
          true,
        );
      } catch (error) {
        failure = error;
        browserAbort(signal);
        browserAbort(tab.queue.signal);
        if (
          error instanceof Error &&
          (/strict mode violation|parsing selector|unknown engine|invalid selector/i.test(
            error.message,
          ) ||
            command.ref)
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw failure ?? new Error("Browser target did not become actionable before timeout.");
  }
  private async showAgentCursor(
    tab: LiveTab,
    point: { x: number; y: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!tab.state.agentControlling) return;
    browserBoundedNumber(point.x, 0, 8192, "Cursor X");
    browserBoundedNumber(point.y, 0, 8192, "Cursor Y");
    const previous = tab.lastCursor ?? point;
    tab.lastCursor = point;
    const animate = await this.evaluate(
      tab,
      `(()=>{
      globalThis.__aidenCursorElement?.remove();const cursor=document.createElement('div');cursor.setAttribute('aria-hidden','true');cursor.setAttribute('data-aiden-browser-cursor','');
      Object.assign(cursor.style,{position:'fixed',left:'0',top:'0',width:'22px',height:'28px',pointerEvents:'none',zIndex:'2147483647',transform:'translate(${previous.x}px,${previous.y}px)',filter:'drop-shadow(0 1px 2px rgba(0,0,0,.25))'});
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 22 28');svg.setAttribute('width','22');svg.setAttribute('height','28');const shape=document.createElementNS('http://www.w3.org/2000/svg','path');shape.setAttribute('d','M2 1 L2 21 L7 16 L11 25 L15 23 L11 14 L19 14 Z');shape.setAttribute('fill','white');shape.setAttribute('stroke','#222');shape.setAttribute('stroke-width','1.5');svg.append(shape);cursor.append(svg);document.documentElement.append(cursor);globalThis.__aidenCursorElement=cursor;
      const animate=!matchMedia('(prefers-reduced-motion: reduce)').matches;cursor.style.transition=animate?'transform 120ms ease-out':'none';requestAnimationFrame(()=>{cursor.style.transform='translate(${point.x}px,${point.y}px)';});return animate;
    })()`,
      signal,
      true,
    );
    if (animate)
      await browserDeadline(new Promise((resolve) => setTimeout(resolve, 120)), 300, signal);
  }
  private async removeAgentCursor(tab: LiveTab): Promise<void> {
    const wc = tab.view.webContents;
    if (!tab.contextId || wc.isDestroyed() || !wc.debugger.isAttached()) return;
    // Cleanup bypasses an interrupted action's signal so user takeover never leaves an overlay behind.
    await browserDeadline(
      wc.debugger.sendCommand("Runtime.evaluate", {
        // Match the isolated world where showAgentCursor stores its element.
        expression:
          "globalThis.__aidenCursorElement?.remove();delete globalThis.__aidenCursorElement;",
        contextId: tab.contextId,
        returnByValue: true,
      }),
      1000,
    ).catch(() => {});
  }

  private async stopClickInterceptor(tab: LiveTab, contextId: number | undefined): Promise<unknown> {
    const wc = tab.view.webContents;
    if (!contextId || wc.isDestroyed() || !wc.debugger.isAttached()) return undefined;
    // A cancelled click must never leave an interceptor blocking the person's next input.
    const result = await browserDeadline(wc.debugger.sendCommand("Runtime.evaluate", {
      contextId,
      expression: "(() => { const guard=globalThis.__aidenClickGuard;delete globalThis.__aidenClickGuard;delete globalThis.__aidenClickTarget;return guard?.stop()??'done'; })()",
      returnByValue: true,
    }), 1000).catch(() => undefined);
    return result?.result?.value;
  }

  private validDefaults(input: Partial<BrowserDefaults>): BrowserDefaults {
    const result = { ...this.defaults, ...input };
    this.profile(result.profileId);
    if (!["system", "light", "dark"].includes(result.appearance))
      throw new Error("Invalid browser appearance.");
    if (!["browser", "external"].includes(result.linkTarget))
      throw new Error("Invalid browser link target.");
    if (!["off", "allow"].includes(result.agentAccess))
      throw new Error("Invalid browser agent access.");
    if (typeof result.autoShow !== "boolean")
      throw new Error("Invalid browser automatic visibility.");
    browserBoundedNumber(result.zoom, 0.25, 5, "Zoom");
    browserBoundedNumber(result.recordingFps, 1, 60, "Recording frame rate");
    result.viewport = this.validViewport(result.viewport);
    return result;
  }
  private validViewport(viewport: BrowserTab["viewport"]): BrowserTab["viewport"] {
    if (!viewport || !["fill", "responsive"].includes(viewport.mode))
      throw new Error("Invalid browser viewport mode.");
    const width = Math.round(browserBoundedNumber(viewport.width, 240, 3_840, "Viewport width"));
    const height = Math.round(browserBoundedNumber(viewport.height, 240, 3_840, "Viewport height"));
    if (width * height > 8_294_400) throw new Error("Browser viewport is too large.");
    return {
      mode: viewport.mode,
      width,
      height,
      ...(typeof viewport.deviceName === "string"
        ? { deviceName: viewport.deviceName.slice(0, 100) }
        : {}),
      ...(typeof viewport.ratioLocked === "boolean" ? { ratioLocked: viewport.ratioLocked } : {}),
    };
  }
  private activateTab(tab: LiveTab): void {
    const workspace = this.workspace(tab.state.workspaceId);
    const previous = workspace.state.activeTabId ? this.tabs.get(workspace.state.activeTabId) : undefined;
    if (previous && previous !== tab && previous.state.floating) {
      this.floating(previous, false, false);
      this.floating(tab, true, false);
    }
    workspace.state.activeTabId = tab.state.id;
  }
  private floating(tab: LiveTab, enabled: boolean, publish = true): void {
    if (tab.state.floating === enabled) return;
    // The renderer supplies bounds for either its sidebar slot or draggable chat overlay.
    // Keep the same sandboxed guest and detach until the destination slot is measured.
    this.detach(tab);
    tab.visible = false;
    tab.state.visible = false;
    tab.floatingViewport =
      enabled && tab.state.viewport.mode === "fill"
        ? { ...tab.state.viewport, mode: "responsive" }
        : undefined;
    tab.state.floating = enabled;
    if (publish) this.emit(tab.state.workspaceId);
  }
  private async pictureInPicture(tab: LiveTab, enabled: boolean): Promise<void> {
    if (tab.pipTimer) {
      clearInterval(tab.pipTimer);
      tab.pipTimer = undefined;
    }
    if (tab.pip && !tab.pip.isDestroyed()) tab.pip.destroy();
    tab.pip = undefined;
    tab.state.pictureInPicture = enabled;
    if (!enabled) return;
    const pip = new BrowserWindow({
      width: 480,
      height: 320,
      minWidth: 240,
      minHeight: 160,
      alwaysOnTop: true,
      title: "Browser Picture in Picture",
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    tab.pip = pip;
    const current = () => tab.pip === pip && !pip.isDestroyed() && !tab.closing;
    pip.once("closed", () => {
      if (tab.pip !== pip) return;
      if (tab.pipTimer) clearInterval(tab.pipTimer);
      tab.pipTimer = undefined;
      tab.pip = undefined;
      tab.state.pictureInPicture = false;
      this.emit(tab.state.workspaceId);
    });
    try {
      await pip.loadURL(
        `data:text/html,${encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>html,body{margin:0;width:100%;height:100%;background:#111}img{width:100%;height:100%;object-fit:contain}</style><img alt="Live browser preview">')}`,
      );
    } catch (error) {
      if (!current()) return;
      pip.destroy();
      throw error;
    }
    if (!current()) return;
    let pending = false;
    const frame = async () => {
      if (pending || !current()) return;
      pending = true;
      try {
        const image = await this.capture(tab);
        if (current())
          await pip.webContents.executeJavaScript(
            `document.querySelector('img').src=${JSON.stringify(`data:${image.mimeType};base64,${image.data}`)}`,
          );
      } catch {
        /* A cold or navigating page retries on the next frame. */
      } finally {
        pending = false;
      }
    };
    await frame();
    if (current()) tab.pipTimer = setInterval(() => void frame(), 250);
  }
  private async startRecording(tab: LiveTab, fps: number, signal?: AbortSignal): Promise<void> {
    if (tab.recording) throw new Error("This browser tab is already recording.");
    browserBoundedNumber(fps, 1, 60, "Recording frame rate");
    const recorder = new BrowserWindow({
      show: false,
      width: 32,
      height: 32,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    tab.pendingRecorder = recorder;
    try {
      await browserDeadline(
        recorder.loadURL(
          `data:text/html,${encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:"><canvas></canvas>')}`,
        ),
        15_000,
        signal,
      );
      browserAbort(signal);
      const bounds = tab.view.getBounds();
      let initialImage: BrowserImage | undefined;
      try {
        initialImage = await this.capture(tab, false, undefined, signal);
      } catch {
        browserAbort(signal);
      }
      await browserDeadline(
        recorder.webContents.executeJavaScript(
          `(async () => {
            const canvas=document.querySelector('canvas');
            canvas.width=${Math.max(1, Math.min(1920, bounds.width))};
            canvas.height=${Math.max(1, Math.min(1080, bounds.height))};
            const context=canvas.getContext('2d');
            const stream=canvas.captureStream(${fps});
            const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
            const media=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4000000});
            const state=globalThis.__aidenRecording={canvas,media,chunks:[],stream,bytes:0,error:null};
            media.ondataavailable=e=>{
              if(!e.data.size)return;
              state.bytes+=e.data.size;
              if(state.bytes>${RECORDING_MAX_BYTES}){
                state.error='Recording reached its size limit.';
                if(media.state!=='inactive')media.stop();
              }else state.chunks.push(e.data);
            };
            media.onerror=e=>{state.error=e.error?.message||'The video encoder failed.';};
            state.publish=()=>{
              if(media.state!=='recording')return;
              context.drawImage(canvas,0,0);
              stream.getVideoTracks()[0].requestFrame?.();
            };
            media.start(100);
            context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);
            ${initialImage ? `const initialImage=new Image();initialImage.src=${JSON.stringify(`data:${initialImage.mimeType};base64,${initialImage.data}`)};await initialImage.decode();context.drawImage(initialImage,0,0,canvas.width,canvas.height);` : ""}
            state.publish();
          })()`,
        ),
        5_000,
        signal,
      );
      // Hidden renderers may not composite a changed canvas until explicitly captured.
      // Readiness is encoded data, not elapsed time: immediate Stop must yield a video.
      const firstFrameDeadline = Date.now() + 5_000;
      while (true) {
        browserAbort(signal);
        const status = await browserDeadline(
          recorder.webContents.executeJavaScript(
            "(() => { const state=globalThis.__aidenRecording; state.publish(); return {bytes:state.bytes,error:state.error}; })()",
          ),
          1_000,
          signal,
        );
        if (status.error) throw new Error(status.error);
        if (status.bytes > 0) break;
        if (Date.now() >= firstFrameDeadline)
          throw new Error("The browser video encoder did not produce its first frame.");
        await browserDeadline(
          recorder.webContents.capturePage(undefined, { stayHidden: true }),
          1_000,
          signal,
        );
        await browserDeadline(
          new Promise((resolve) => setTimeout(resolve, Math.min(100, 1000 / fps))),
          1_000,
          signal,
        );
      }
      const recording: RecordingSession = {
        id: `recording-${randomUUID()}`,
        started: Date.now(),
        recorder,
        pending: Promise.resolve(),
        stopTimer: setTimeout(() => {
          void this.stopRecording(tab).catch(() => {});
        }, 5 * 60_000),
      };
      tab.recording = recording;
      tab.state.recording = true;
      try {
        await this.send(
          tab,
          "Page.startScreencast",
          { format: "jpeg", quality: 80, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 },
          signal,
        );
      } catch (error) {
        clearTimeout(recording.stopTimer);
        tab.recording = undefined;
        tab.state.recording = false;
        if (!recorder.isDestroyed()) recorder.destroy();
        throw error;
      }
      tab.pendingRecorder = undefined;
      this.emit(tab.state.workspaceId);
    } catch (error) {
      tab.pendingRecorder = undefined;
      if (!recorder.isDestroyed()) recorder.destroy();
      throw error;
    }
  }
  private recordFrame(tab: LiveTab, params: Record<string, any>): void {
    const wc = tab.view.webContents;
    if (!wc.isDestroyed() && wc.debugger.isAttached())
      void wc.debugger
        .sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId })
        .catch(() => {});
    const recording = tab.recording;
    if (
      !recording ||
      recording.busy ||
      typeof params.data !== "string" ||
      params.data.length > 8_000_000
    )
      return;
    recording.busy = true;
    recording.pending = recording.pending
      .then(async () => {
        if (recording.recorder.isDestroyed()) return;
        await browserDeadline(
          recording.recorder.webContents.executeJavaScript(
            `(async () => { const state=globalThis.__aidenRecording; const image=new Image(); image.src=${JSON.stringify(`data:image/jpeg;base64,${params.data}`)}; await image.decode(); state.canvas.getContext('2d').drawImage(image,0,0,state.canvas.width,state.canvas.height); state.publish(); })()`,
          ),
          3_000,
        );
      })
      .catch((error) => {
        recording.failed = String(error).slice(0, 200);
      })
      .finally(() => {
        recording.busy = false;
      });
  }
  private async stopRecording(tab: LiveTab): Promise<BrowserRecording> {
    const recording = tab.recording;
    if (!recording) throw new Error("This browser tab is not recording.");
    tab.recording = undefined;
    tab.state.recording = false;
    clearTimeout(recording.stopTimer);
    try {
      await this.send(tab, "Page.stopScreencast").catch(() => {});
      await recording.pending;
      if (recording.failed) throw new Error(recording.failed);
      const base64 = await browserDeadline(
        recording.recorder.webContents.executeJavaScript(
          `(async () => { const state=globalThis.__aidenRecording; if(state.media.state!=='inactive') await new Promise(resolve=>{state.media.onstop=resolve;state.media.stop();}); for(const track of state.stream.getTracks())track.stop(); if(state.error)throw new Error(state.error); const blob=new Blob(state.chunks,{type:'video/webm'}); return await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(blob);}); })()`,
        ),
        15_000,
      );
      if (typeof base64 !== "string" || base64.length > RECORDING_MAX_BYTES * 1.4)
        throw new Error("Recording output is invalid or too large.");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length < 16 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
        throw new Error(
          "The browser did not produce a video frame. Wait for the page to render and record again.",
        );
      const folder = path.join(app.getPath("userData"), "browser", "recordings");
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const target = path.join(folder, `${recording.id}.webm`);
      await fs.writeFile(target, bytes, { mode: 0o600 });
      const result = {
        id: recording.id,
        path: target,
        mimeType: "video/webm",
        durationMs: Date.now() - recording.started,
        sizeBytes: bytes.length,
      };
      this.recordings.set(result.id, result);
      return result;
    } finally {
      if (!recording.recorder.isDestroyed()) recording.recorder.destroy();
      this.emit(tab.state.workspaceId);
    }
  }
  private async pick(tab: LiveTab, signal?: AbortSignal): Promise<BrowserAnnotation | undefined> {
    tab.picking = true;
    try {
      const picked = await browserDeadline(
        tab.view.webContents.executeJavaScript(
          `new Promise((resolve,reject)=>{
      globalThis.__aidenPickerCancel?.(); const overlay=document.createElement('div'); Object.assign(overlay.style,{position:'fixed',pointerEvents:'none',zIndex:'2147483647',outline:'2px solid #888',background:'rgba(128,128,128,.12)',borderRadius:'4px'}); document.documentElement.append(overlay);
      let timer; const suppress=e=>{e.preventDefault();e.stopImmediatePropagation();};const pointerEvents=['pointerdown','mousedown','pointerup','mouseup'];const cleanup=()=>{clearTimeout(timer);overlay.remove();document.removeEventListener('pointermove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',key,true);for(const name of pointerEvents)document.removeEventListener(name,suppress,true);delete globalThis.__aidenPickerCancel;};
      const cancel=()=>{cleanup();resolve(null);}; globalThis.__aidenPickerCancel=cancel;
      const move=e=>{const target=e.composedPath().find(node=>node instanceof Element)||e.target;const r=target.getBoundingClientRect();Object.assign(overlay.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});};
      const key=e=>{if(e.key==='Escape'||e.key==='.'&&(e.metaKey||e.ctrlKey)){e.preventDefault();e.stopImmediatePropagation();cancel();}};
      const selectorFor=element=>{const sections=[];let target=element;while(target){const root=target.getRootNode();const pieces=[];for(let current=target;current;current=current.parentElement){if(current.id&&root.querySelectorAll('#'+CSS.escape(current.id)).length===1){pieces.unshift('#'+CSS.escape(current.id));break;}const siblings=current.parentElement?[...current.parentElement.children].filter(sibling=>sibling.localName===current.localName):[current];pieces.unshift(CSS.escape(current.localName)+':nth-of-type('+(siblings.indexOf(current)+1)+')');}sections.unshift(pieces.join(' > '));target=root instanceof ShadowRoot?root.host:null;}return sections.join(' >> ');};
      const click=e=>{e.preventDefault();e.stopImmediatePropagation();const el=e.composedPath().find(node=>node instanceof Element)||e.target,r=el.getBoundingClientRect();const attrs={};for(const a of [...el.attributes].slice(0,20)){if(!/^on/i.test(a.name)&&a.name!=='value')attrs[a.name]=a.value.slice(0,500);} const style=getComputedStyle(el);for(const name of ['font-family','font-size','font-weight','line-height','color','background-color','opacity','border-radius','border-color','border-width','border-style','width','height','padding','margin','gap','display'])attrs['style:'+name]=style.getPropertyValue(name);let source=[];try{let fiber=el[Object.keys(el).find(k=>k.startsWith('__reactFiber$'))];for(let i=0;fiber&&i<8;i++,fiber=fiber.return){const t=fiber.type;const name=typeof t==='function'?(t.displayName||t.name):typeof t==='string'?t:'';const debug=fiber._debugSource||fiber._debugOwner?._debugSource;const stack=fiber._debugStack?.stack;if(name||debug||stack)source.push({component:name,file:debug?.fileName,line:debug?.lineNumber,stack:typeof stack==='string'?stack.slice(0,1500):undefined});}}catch{}const selector=selectorFor(el);const value={url:location.href,selectedText:(window.getSelection()?.toString()||'').slice(0,10000),elements:[{ref:'pick',tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||undefined,text:(el.getAttribute('aria-label')||el.innerText||'').slice(0,2000),selector,bounds:{x:r.x,y:r.y,width:r.width,height:r.height},attributes:attrs,source:JSON.stringify(source)}],regions:[],strokes:[],comment:''};cleanup();resolve(value);};
      document.addEventListener('pointermove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',key,true);for(const name of pointerEvents)document.addEventListener(name,suppress,true);timer=setTimeout(cancel,60000);
    })`,
          true,
        ),
        61_000,
        signal,
      );
      if (!picked) return undefined;
      const annotation = this.sanitizeAnnotation(picked);
      try {
        annotation.image = await this.capture(tab, false, undefined, signal);
      } catch {
        browserAbort(
          signal,
        ); /* Selected text and element context remain useful when capture is unavailable. */
      }
      return annotation;
    } finally {
      tab.picking = false;
      if (signal?.aborted && !tab.view.webContents.isDestroyed())
        void tab.view.webContents
          .executeJavaScript("globalThis.__aidenPickerCancel?.()")
          .catch(() => {});
    }
  }
  private sanitizeAnnotation(value: BrowserAnnotation): BrowserAnnotation {
    if (!value || typeof value !== "object") throw new Error("Invalid browser annotation.");
    if (JSON.stringify(value).length > 12_000_000)
      throw new Error("Browser annotation is too large.");
    const elements = (Array.isArray(value.elements) ? value.elements : [])
      .slice(0, 50)
      .map((element) => ({
        ref: text(element.ref, "element ref", 100),
        tag: text(element.tag, "element tag", 100),
        text: text(element.text, "element text", 10_000),
        selector: text(element.selector, "element selector", 4_000),
        bounds: boundedBounds(element.bounds),
        ...(typeof element.role === "string" ? { role: element.role.slice(0, 100) } : {}),
        ...(typeof element.source === "string" ? { source: element.source.slice(0, 8_000) } : {}),
        attributes: Object.fromEntries(
          Object.entries(element.attributes ?? {})
            .slice(0, 40)
            .map(([key, val]) => [key.slice(0, 100), text(val, "element attribute", 2_000)]),
        ),
      }));
    const annotation: BrowserAnnotation = {
      url: browserDisplayUrl(browserUrl(value.url)),
      elements,
      regions: (Array.isArray(value.regions) ? value.regions : []).slice(0, 50).map(boundedBounds),
      strokes: (Array.isArray(value.strokes) ? value.strokes : []).slice(0, 100).map((stroke) =>
        stroke.slice(0, 2_000).map((point) => ({
          x: browserBoundedNumber(point.x, -20_000, 20_000, "Stroke X"),
          y: browserBoundedNumber(point.y, -20_000, 20_000, "Stroke Y"),
        })),
      ),
      comment: text(value.comment, "annotation comment", 10_000),
    };
    const selectedText = (value as BrowserAnnotation & { selectedText?: string }).selectedText;
    if (typeof selectedText === "string")
      Object.assign(annotation, { selectedText: selectedText.slice(0, 10_000) });
    if (value.styleChanges)
      annotation.styleChanges = Object.fromEntries(
        Object.entries(value.styleChanges)
          .slice(0, 40)
          .map(([key, val]) => [key.slice(0, 100), text(val, "style change", 2_000)]),
      );
    if (value.elementStyleChanges) {
      if (!Array.isArray(value.elementStyleChanges)) throw new Error("Invalid element style changes.");
      annotation.elementStyleChanges = value.elementStyleChanges.slice(0, 50).map((element) => ({
        ref: text(element.ref, "style element reference", 100),
        selector: text(element.selector, "style element selector", 4_000),
        changes: Object.fromEntries(Object.entries(element.changes ?? {}).slice(0, 40).map(([property, change]) => [text(property, "CSS property", 100), {
          previous: text(change.previous, "previous CSS value", 2_000),
          current: text(change.current, "current CSS value", 2_000),
        }])),
      }));
    }
    if (value.image) annotation.image = this.validImage(value.image);
    if (value.imageBounds) annotation.imageBounds = boundedBounds(value.imageBounds);
    return annotation;
  }
  private validImage(image: BrowserImage): BrowserImage {
    if (!image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg"))
      throw new Error("Invalid browser image type.");
    if (
      typeof image.data !== "string" ||
      image.data.length > MAX_CAPTURE_BYTES * 1.4 ||
      !/^[A-Za-z\d+/]*={0,2}$/.test(image.data)
    )
      throw new Error("Invalid browser image data.");
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
    if (decoded.isEmpty()) throw new Error("Browser image cannot be decoded.");
    const size = decoded.getSize();
    if (size.width * size.height > 32_000_000) throw new Error("Browser image is too large.");
    return { data: decoded.toPNG().toString("base64"), mimeType: "image/png", ...size };
  }

  async command(
    workspaceId: string,
    command: BrowserCommand,
    context: CommandContext,
  ): Promise<BrowserCommandResult> {
    try { return await this.runCommand(workspaceId, command, context); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redacted = browserFileService.redactText(message);
      if (message === redacted) throw error;
      throw new Error(redacted);
    }
  }
  private async runCommand(
    workspaceId: string,
    command: BrowserCommand,
    context: CommandContext,
  ): Promise<BrowserCommandResult> {
    browserAbort(context.signal);
    if (!command || typeof command !== "object" || typeof command.action !== "string")
      throw new Error("Invalid browser command.");
    if (!(await configStore.getWorkspace(workspaceId)))
      throw new Error("This workspace no longer exists.");
    browserAbort(context.signal);
    if (context.owner) this.attachOwner(workspaceId, context.owner);
    const workspace = this.workspace(workspaceId);
    this.mainWindow(workspaceId);
    if (context.source === "agent") {
      if (!this.getState(workspaceId).agentAccessAllowed)
        throw new Error("Agent browser access is disabled in Browser settings.");
      if (!ACTIONS_AGENT.has(command.action))
        throw new Error("This browser command is available only to the user.");
    }
    const result: BrowserCommandResult = { state: this.getState(workspaceId) };
    const signal = context.signal;
    const input = command as BrowserCommand & Record<string, any>;
    switch (command.action) {
      case "open_file": {
        const controller = context.source === "agent" ? new AbortController() : undefined;
        if (controller) {
          const acquisitions = this.agentFileAcquisitions.get(workspaceId) ?? new Set<AbortController>();
          acquisitions.add(controller); this.agentFileAcquisitions.set(workspaceId, acquisitions);
        }
        const acquisitionSignal = controller ? AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) : signal;
        let reservation: BrowserFileReservation | undefined;
        let created: LiveTab | undefined;
        try {
          reservation = await browserFileService.open(workspaceId, command.path, {
            preparedFile: context.preparedFile, assetPaths: command.assetPaths, signal: acquisitionSignal,
          });
          browserAbort(acquisitionSignal);
          const show = command.show ?? (context.source === "user" || this.defaults.autoShow);
          if (command.tabId) {
            await this.command(workspaceId, { action: "navigate", tabId: command.tabId, url: reservation.url, readiness: command.readiness, timeoutMs: command.timeoutMs }, { ...context, signal: acquisitionSignal });
            result.tabId = command.tabId;
            if (show) await this.command(workspaceId, { action: "select", tabId: command.tabId }, context);
          } else {
            created = await this.create(workspaceId, reservation.url, undefined, show);
            result.tabId = created.state.id;
            if (command.readiness !== "none") await browserDeadline(created.initialLoad!, command.timeoutMs ?? 15000, acquisitionSignal);
          }
          browserAbort(acquisitionSignal);
        } catch (error) {
          if (created) this.close(created);
          throw error;
        } finally {
          reservation?.release();
          if (controller) {
            const acquisitions = this.agentFileAcquisitions.get(workspaceId);
            acquisitions?.delete(controller);
            if (!acquisitions?.size) this.agentFileAcquisitions.delete(workspaceId);
          }
        }
        break;
      }
      case "open_link": {
        const url = browserUrl(command.url);
        if (command.alternateTarget || this.defaults.linkTarget === "external")
          await shell.openExternal(url);
        else {
          const created = await this.create(workspaceId, url, undefined, true);
          result.tabId = created.state.id;
        }
        break;
      }
      case "create": {
        const created = await this.create(
          workspaceId,
          command.url,
          command.profileId,
          typeof input.show === "boolean"
            ? input.show
            : context.source === "user" || this.defaults.autoShow,
        );
        result.tabId = created.state.id;
        break;
      }
      case "agent_access":
        if (!["inherit", "allow", "off"].includes(command.access))
          throw new Error("Invalid workspace browser access.");
        if (command.access === "inherit") this.workspaceAccess.delete(workspaceId);
        else this.workspaceAccess.set(workspaceId, command.access);
        if (!this.getState(workspaceId).agentAccessAllowed)
          this.cancelFileAcquisitions(workspaceId);
        if (!this.getState(workspaceId).agentAccessAllowed)
          for (const tab of this.tabs.values())
            if (tab.state.workspaceId === workspaceId) tab.queue.interrupt();
        this.save();
        this.emit(workspaceId);
        break;
      case "defaults":
        this.defaults = this.validDefaults(command.defaults);
        for (const workspaceId of this.agentFileAcquisitions.keys())
          if (!this.getState(workspaceId).agentAccessAllowed) this.cancelFileAcquisitions(workspaceId);
        for (const tab of this.tabs.values())
          if (!this.getState(tab.state.workspaceId).agentAccessAllowed) tab.queue.interrupt();
        this.save();
        this.emitAll();
        break;
      case "profile_create":
        if (this.profiles.filter((p) => p.id.startsWith("profile-")).length >= 24)
          throw new Error("The browser profile limit has been reached.");
        this.profiles.push({
          id: `profile-${randomUUID()}`,
          name: profileName(command.name),
          kind: "persistent",
        });
        this.save();
        this.emitAll();
        break;
      case "profile_rename": {
        const profile = this.profile(command.profileId);
        if (!profile.id.startsWith("profile-"))
          throw new Error("Built-in profiles cannot be renamed.");
        profile.name = profileName(command.name);
        this.save();
        this.emitAll();
        break;
      }
      case "profile_delete": {
        const profile = this.profile(command.profileId);
        if (!profile.id.startsWith("profile-"))
          throw new Error("Built-in profiles cannot be deleted.");
        const browserSession = this.browserSession(profile.id);
        for (const tab of [...this.tabs.values()])
          if (tab.state.profileId === profile.id) this.close(tab);
        this.deletingProfiles.add(profile.id);
        try {
          await browserSession.clearStorageData();
          await browserSession.clearCache();
          this.profiles = this.profiles.filter((p) => p.id !== profile.id);
          if (this.defaults.profileId === profile.id) this.defaults.profileId = "default";
          this.save();
          this.emitAll();
        } finally {
          this.deletingProfiles.delete(profile.id);
        }
        break;
      }
      case "clear_cookies":
        await this.browserSession(command.profileId).clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "serviceworkers"],
        });
        break;
      case "clear_cache":
        await this.browserSession(command.profileId).clearCache();
        break;
      case "history_remove":
        workspace.state.history = workspace.state.history.filter((h) => h.url !== command.url);
        this.emit(workspaceId);
        break;
      case "import_sources":
        result.importSources = await browserImportSources();
        break;
      case "import_cookies":
        result.importResult = await importBrowserCookies(
          command.sourceId,
          this.browserSession(command.profileId),
        );
        break;
      case "save_image": {
        const image = this.validImage(command.image);
        const saved = await dialog.showSaveDialog(this.mainWindow(workspaceId), {
          defaultPath: "browser-screenshot.png",
          filters: [{ name: "PNG image", extensions: ["png"] }],
        });
        if (!saved.canceled && saved.filePath) {
          await fs.writeFile(saved.filePath, Buffer.from(image.data, "base64"));
          result.value = { path: saved.filePath };
        }
        break;
      }
      case "reveal_recording": {
        const recording = this.recordings.get(command.recordingId);
        if (!recording) throw new Error("This recording is no longer available.");
        shell.showItemInFolder(recording.path);
        break;
      }
      default: {
        if (!("tabId" in command)) throw new Error("This browser command requires a tab.");
        const tab = this.tab(workspaceId, command.tabId);
        const wc = tab.view.webContents;
        result.tabId = tab.state.id;
        // Panel cleanup can cancel an already inactive picker. Hiding browser
        // chrome must not interrupt automation or invalidate pending approval.
        if (command.action === "annotate" && !command.enabled && !tab.picking) break;
        if (context.source === "user" && command.action !== "present") tab.queue.interrupt();
        if (command.action === "present") {
          this.present(tab, command.visible, command.bounds);
          break;
        }
        if (command.action === "select") {
          this.activateTab(tab);
          this.emit(workspaceId);
          if (context.source === "agent" && !tab.state.floating)
            this.emit(workspaceId, { type: "show", workspaceId, tabId: tab.state.id });
          break;
        }
        if (command.action === "close") {
          this.close(tab);
          break;
        }
        if (command.action === "annotate" && !command.enabled) {
          await wc.executeJavaScript("globalThis.__aidenPickerCancel?.()");
          break;
        }
        const actionEvent: Record<string, unknown> = {
          id: randomUUID(),
          action: command.action,
          status: "running",
          startedAt: Date.now(),
        };
        if (context.source === "agent") {
          tab.timeline.push(actionEvent);
          tab.timeline = tab.timeline.slice(-200);
        }
        await tab.queue.run(async (queueCheck) => {
          const check = queueCheck;
          const signals = [context.signal, tab.queue.signal].filter(
            (candidate): candidate is AbortSignal => Boolean(candidate),
          );
          const signal = signals.length ? AbortSignal.any(signals) : undefined;
          tab.state.agentControlling = context.source === "agent";
          this.emit(workspaceId);
          try {
            check();
            context.beforeEffect?.();
            switch (command.action) {
              case "navigate": {
                const url = browserUrl(command.url);
                this.beginPreviewNavigation(tab, url);
                const sequence = tab.committedNavigation;
                const startedAtSequence = tab.navigationSequence;
                const loading = wc.loadURL(url);
                try {
                  if (input.readiness === "none") void loading.catch(() => {});
                  else if (input.readiness === "domContentLoaded") {
                    void loading.catch(() => {});
                    await this.wait(
                      tab,
                      { text: "", timeoutMs: input.timeoutMs ?? 15000, readiness: true, navigationAfter: sequence },
                      signal,
                      check,
                    );
                  } else await browserDeadline(loading, input.timeoutMs ?? 15000, signal);
                } catch (error) {
                  if (!wc.isDestroyed() && tab.navigationSequence <= startedAtSequence + 1) {
                    wc.stop();
                    this.finishPreviewNavigation(tab);
                  }
                  throw error;
                }
                break;
              }
              case "back":
                if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
                break;
              case "forward":
                if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
                break;
              case "stop":
                wc.stop();
                break;
              case "focus":
                wc.focus();
                break;
              case "reload":
                tab.state.crashed = false;
                tab.state.error = undefined;
                if (command.ignoreCache) wc.reloadIgnoringCache();
                else wc.reload();
                break;
              case "devtools":
                if (wc.debugger.isAttached()) wc.debugger.detach();
                wc.openDevTools({ mode: "detach" });
                break;
              case "open_external":
                await shell.openExternal(browserUrl(wc.getURL()));
                break;
              case "viewport":
                tab.state.viewport = this.validViewport(command.viewport);
                await this.applyEmulation(tab);
                break;
              case "appearance":
                if (!["system", "light", "dark"].includes(command.appearance))
                  throw new Error("Invalid browser appearance.");
                tab.state.appearance = command.appearance;
                await this.applyEmulation(tab);
                break;
              case "zoom":
                tab.state.zoom = browserBoundedNumber(command.zoom, 0.25, 5, "Zoom");
                wc.setZoomFactor(tab.state.zoom);
                break;
              case "mute":
                if (typeof command.muted !== "boolean")
                  throw new Error("Invalid audio mute state.");
                wc.setAudioMuted(command.muted);
                tab.state.muted = command.muted;
                break;
              case "float":
                this.floating(tab, command.floating);
                break;
              case "picture_in_picture":
                await this.pictureInPicture(tab, command.enabled);
                break;
              case "screenshot":
                result.image = await this.capture(tab, command.fullPage, command.bounds, signal);
                break;
              case "snapshot":
                result.snapshot = await this.snapshot(
                  tab,
                  command.includeImage !== false && context.supportsImages !== false,
                  signal,
                  context.source === "user" && input.includeAllElements === true,
                );
                break;
              case "click": {
                const hasTarget = Boolean(command.ref || command.selector || command.locator);
                if (hasTarget && (command.x !== undefined || command.y !== undefined))
                  throw new Error("Provide one click target.");
                const point = hasTarget
                  ? await this.elementPoint(tab, command, signal, true)
                  : {
                      x: browserBoundedNumber(command.x, 0, 8192, "Click X"),
                      y: browserBoundedNumber(command.y, 0, 8192, "Click Y"),
                    };
                check();
                const button = command.button ?? "left";
                if (!["left", "right", "middle"].includes(button))
                  throw new Error("Invalid mouse button.");
                const clickCount = browserBoundedNumber(
                  command.clickCount ?? 1,
                  1,
                  3,
                  "Click count",
                );
                const clickContextId = hasTarget ? tab.contextId : undefined;
                let hit: unknown;
                try {
                  await this.showAgentCursor(tab, point, signal);
                  check();
                  await this.send(
                    tab,
                    "Input.dispatchMouseEvent",
                    { type: "mouseMoved", ...point },
                    signal,
                  );
                  check();
                  if (hasTarget) {
                    if (tab.contextId !== clickContextId) throw new Error("The browser page changed before the click. Take a fresh snapshot.");
                    // Hover can move the target or open an overlay. Recheck the pinned
                    // element after mouseMoved, then guard the actual trusted input events.
                    await this.evaluate(tab, `(() => {
                      const node=globalThis.__aidenClickTarget;
                      globalThis.__aidenClickGuard?.stop();
                      const guard=globalThis.__aidenPlaywright.setupHitTargetInterceptor(node,'mouse',${JSON.stringify(point)},false);
                      if(typeof guard==='string')throw new Error('Another element covers the target or it moved: '+guard);
                      globalThis.__aidenClickGuard=guard;
                    })()`, signal, true);
                    check();
                    if (tab.contextId !== clickContextId) throw new Error("The browser page changed before the click. Take a fresh snapshot.");
                  }
                  context.beforeEffect?.();
                  try {
                    await this.send(tab, "Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount, ...point }, signal);
                    check();
                  } finally {
                    await this.send(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount, ...point });
                  }
                } finally {
                  hit = await this.stopClickInterceptor(tab, clickContextId);
                }
                if (hit !== undefined && hit !== "done") throw new Error("Another element covered the target during the click. Take a fresh snapshot.");
                break;
              }
              case "type": {
                text(command.text, "browser input");
                if (command.ref || command.selector || command.locator) {
                  const point = await this.elementPoint(tab, command, signal);
                  await this.showAgentCursor(tab, point, signal);
                }
                check();
                const target = this.target(tab, command);
                context.beforeEffect?.();
                await this.evaluate(
                  tab,
                  `(()=>{const e=${target};if(!e)throw new Error('Input not found');if(!globalThis.__aidenPlaywright.elementState(e,'editable').matches)throw new Error('Target is not editable or is read-only');e.focus();${command.clear ? "if('select' in e)e.select();else {const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}" : ""}})()`,
                  signal,
                  true,
                );
                check();
                context.beforeEffect?.();
                if (command.clear && command.text === "")
                  await this.press(tab, "Backspace", undefined, signal, check, context.beforeEffect);
                else await this.send(tab, "Input.insertText", { text: command.text }, signal);
                break;
              }
              case "press":
                await this.press(tab, command.key, command.modifiers, signal, check, context.beforeEffect);
                break;
              case "scroll": {
                const point =
                  input.selector || input.locator
                    ? await this.elementPoint(
                        tab,
                        { selector: input.selector, locator: input.locator },
                        signal,
                      )
                    : { x: command.x ?? 200, y: command.y ?? 200 };
                check();
                await this.showAgentCursor(tab, point, signal);
                check();
                context.beforeEffect?.();
                await this.send(
                  tab,
                  "Input.dispatchMouseEvent",
                  {
                    type: "mouseWheel",
                    x: browserBoundedNumber(point.x, 0, 8192, "Scroll X"),
                    y: browserBoundedNumber(point.y, 0, 8192, "Scroll Y"),
                    deltaX: browserBoundedNumber(
                      command.deltaX,
                      -100000,
                      100000,
                      "Horizontal scroll",
                    ),
                    deltaY: browserBoundedNumber(
                      command.deltaY,
                      -100000,
                      100000,
                      "Vertical scroll",
                    ),
                  },
                  signal,
                );
                break;
              }
              case "evaluate":
                context.beforeEffect?.();
                result.value = browserResult(
                  await this.evaluate(
                    tab,
                    text(command.expression, "JavaScript expression"),
                    signal,
                    false,
                    input.awaitPromise !== false,
                    input.returnByValue !== false,
                  ),
                );
                break;
              case "annotation_preview":
                result.elementStyleChanges = await this.evaluate(tab, buildBrowserAnnotationPreviewApplyExpression(command.changes), signal, true);
                result.snapshot = await this.snapshot(tab, true, signal, true, command.changes);
                break;
              case "annotation_reset":
                await this.evaluate(tab, buildBrowserAnnotationPreviewResetExpression(), signal, true);
                break;
              case "wait":
                await this.wait(tab, input, signal, check);
                break;
              case "record_start":
                await this.startRecording(tab, command.fps ?? this.defaults.recordingFps, signal);
                break;
              case "record_stop":
                result.recording = await this.stopRecording(tab);
                break;
              case "annotate":
                Object.assign(result, { annotation: await this.pick(tab, signal) });
                break;
              case "annotation_submit": {
                const annotation = this.sanitizeAnnotation(command.annotation);
                result.annotation = annotation;
                if (command.delivery !== "renderer") {
                  this.emit(workspaceId, {
                    type: "annotation",
                    workspaceId,
                    tabId: tab.state.id,
                    annotation,
                  });
                }
                break;
              }
              default:
                throw new Error("Unknown browser command.");
            }
            actionEvent.status = "succeeded";
          } catch (error) {
            actionEvent.status = "failed";
            actionEvent.error = error instanceof Error ? error.message : "Browser action failed.";
            throw error;
          } finally {
            await this.removeAgentCursor(tab);
            actionEvent.completedAt = Date.now();
            tab.state.agentControlling = false;
            this.emit(workspaceId);
          }
        }, signal);
      }
    }
    result.state = this.getState(workspaceId);
    return redactBrowserData(result);
  }
  private async press(
    tab: LiveTab,
    keyInput: string,
    modifiersInput: Array<"Alt" | "Control" | "Meta" | "Shift"> | undefined,
    signal?: AbortSignal,
    check = () => {},
    beforeEffect?: () => void,
  ): Promise<void> {
    const parts = text(keyInput, "keyboard key", 100).split("+");
    const key = parts.pop()!;
    const names = [...parts, ...(modifiersInput ?? [])];
    const bits: Record<string, number> = {
      Alt: 1,
      Control: 2,
      Meta: 4,
      Shift: 8,
      Ctrl: 2,
      Command: 4,
    };
    let modifiers = 0;
    for (const name of names) {
      if (!bits[name]) throw new Error("Unsupported keyboard modifier.");
      modifiers |= bits[name];
    }
    const codes: Record<string, number> = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      Space: 32,
    };
    const code = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
    if (code === undefined) throw new Error("Unsupported keyboard key.");
    const event = {
      key: key === "Space" ? " " : key,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
      modifiers,
    };
    beforeEffect?.();
    try {
      await this.send(
        tab,
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          ...event,
          ...(key.length === 1 && !modifiers
            ? { text: key }
            : key === "Enter"
              ? { text: "\r" }
              : {}),
        },
        signal,
      );
      check();
    } finally {
      await this.send(tab, "Input.dispatchKeyEvent", { type: "keyUp", ...event });
    }
  }
  private async wait(
    tab: LiveTab,
    input: Record<string, any>,
    signal?: AbortSignal,
    check = () => {},
  ): Promise<void> {
    const timeout = browserBoundedNumber(input.timeoutMs ?? 15000, 1, 60000, "Wait timeout");
    const end = Date.now() + timeout;
    if (
      !input.selector &&
      !input.locator &&
      input.text === undefined &&
      !input.urlIncludes &&
      !input.readiness
    )
      throw new Error("Provide at least one browser wait condition.");
    const target = input.selector || input.locator ? this.target(tab, input) : undefined;
    while (Date.now() < end) {
      check();
      browserAbort(signal);
      if (input.navigationAfter !== undefined && tab.committedNavigation <= input.navigationAfter) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      try {
        const ready = await this.evaluate(
          tab,
          `(()=>{return ${target ? `Boolean(${target})` : "true"} && ${input.text !== undefined ? `(document.body?.innerText||'').includes(${JSON.stringify(text(input.text, "wait text", 4000))})` : "true"} && ${input.urlIncludes ? `location.href.includes(${JSON.stringify(text(input.urlIncludes, "wait URL", 4000))})` : "true"} && ${input.readiness ? "document.readyState!=='loading'" : "true"};})()`,
          signal,
          true,
        );
        if (ready) return;
      } catch (error) {
        check();
        browserAbort(signal);
        browserAbort(tab.queue.signal);
        if (error instanceof Error && /selector/i.test(error.message)) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Browser wait timed out before all conditions matched.");
  }
}

export const browserService = new BrowserService();
