// Production wiring for the design canvas. No logic here: the store and the
// handlers are tested directly. Constructing the store does no I/O, so
// workspace cleanup can remove a canvas even while the design-mode flag is off.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findEnvKeys, getProviders } from "@earendil-works/pi-ai/compat";
import { persistedChatWorkspaceId } from "../../../renderer/shared/chat-workspace.js";
import { designBrowserServers } from "../../../renderer/shared/design-app.js";
import { app, ipcMain, logger } from "../../platform.js";
import { reportAnalyticsEvent } from "../analytics/analytics-report.js";
import { browserService } from "../browser/service.js";
import { chatStore } from "../chat-store.js";
import { configStore } from "../config-store.js";
import { DesignCanvasSnapshots } from "./canvas-snapshots.js";
import { createDesignCanvasCarry } from "./carry.js";
import { createDesignChatCleanup, createDesignWorkspaceCleanup } from "./cleanup.js";
import { DesignModeConsent } from "./design-mode-tool.js";
import { ATTACH_EXCLUDED_PORTS, designAppAttachDeps, type DesignAppAttachDeps } from "./app-server/app-attach.js";
import { DesignAppConsent } from "./app-server/app-consent.js";
import { detectWebApp } from "./app-server/app-detect.js";
import { launchDirsUnchanged, readLaunchSurface } from "./app-server/app-fingerprint.js";
import { providerKeyNames } from "./app-server/app-launch-core.js";
import { chooseAppPort, defaultOsPort } from "./app-server/app-ports.js";
import { createDesignAppRecords } from "./app-server/app-records.js";
import { DESIGN_APP_PRESENCE_GRACE_MS, DesignAppServers, type DesignAppJobs } from "./app-server/app-server-main.js";
import { clearAppToolchainCache, resolveDesignToolchain } from "./app-server/app-toolchain.js";
import { readCanvasConfig, saveCanvasConfigApp } from "./canvas-config.js";
import {
  designAppTemplateDir,
  draftMockDesignMd,
  e2eDesignAppNodeModules,
  firstMockConfig,
  linkDesignAppNodeModules,
  readMockInputs,
  readTemplate,
  writeMockApp,
} from "./app-server/mock-app.js";
import { placeMockHome } from "./mock-home.js";
import { deviceBucket } from "../../../renderer/shared/design-canvas/app-devices.js";
import type { DesignJobView } from "../follow-through/background-jobs.js";
import { defaultSocketReaderDeps, type ProcessRow } from "../follow-through/listening-ports.js";
import { agentShellCommandEnvironment } from "../agent-command-environment.js";
import { workspaceMutationGate } from "../workspace-mutation-gate.js";
import { designLiveEnabled } from "../studio/feature-flags.js";
import { runDesignMdWorker } from "./design-md/lint-client.js";
import { createDesignAppRoots } from "./design-md/locate.js";
import { DesignMdOffers } from "./design-md/offers.js";
import { DesignMdReader } from "./design-md/reader.js";
import { DesignGrantRegistry } from "./grants.js";
import { createDesignLiveChats } from "./liveness.js";
import { DESIGN_CANVAS_UPDATED_CHANNEL, DesignCanvasStore, DesignChatCanvases, type DesignCanvasUpdated } from "./store.js";
import { createDesignTitleFollow } from "./title-follow.js";
import { DesignCanvasViews, designTurnPages } from "./views.js";
import { DESIGN_FILES_CHANGED_CHANNEL, DesignFileWatcher } from "./watch.js";
import { PendingEntries, RecentWrittenPages } from "./written-pages.js";
import { installedAppNetwork } from "./app-frames/app-network-main.js";

/** One canvas file per workspace, under `userData/design-canvases/`. */
export const designWorkspaceCanvasStore = new DesignCanvasStore({
  root: () => path.join(app.getPath("userData"), "design-canvases"),
});

/** Whether the chat still exists and is in that workspace: a chat that moved away is not live there. */
async function designChatIsLive(chatId: string, workspaceId: string): Promise<boolean> {
  const meta = await chatStore.getMeta(chatId);
  return meta !== null && persistedChatWorkspaceId(meta.workspaceId) === workspaceId;
}

/** Which of `chatIds` are live in the workspace, for claims on its canvas: one chat index read per check. */
export const designLiveChats = createDesignLiveChats(chatStore);

/** The workspace canvases seen through chats: what handlers, tools and placements use. */
export const designCanvasStore = new DesignChatCanvases({
  store: designWorkspaceCanvasStore,
  workspaceIdOf: async (chatId) => {
    const meta = await chatStore.getMeta(chatId);
    return meta ? persistedChatWorkspaceId(meta.workspaceId) : null;
  },
  workspaceExists: async (workspaceId) => (await configStore.getWorkspace(workspaceId)) !== undefined,
  chatIsLive: designChatIsLive,
});

/**
 * Tells every window that a workspace's canvas changed. The store call that
 * made the change returned the workspace it used, and that is the one named.
 * A broadcast that fails is logged: the change itself has landed.
 */
export function broadcastDesignCanvasUpdate(update: DesignCanvasUpdated): void {
  try {
    ipcMain.broadcast(DESIGN_CANVAS_UPDATED_CHANNEL, update);
  } catch (error) {
    logger.warn("design", "Could not announce a canvas change.", error);
  }
}

/** A page made for a chat follows the chat's title; entry runs it once more after claiming. */
export const designTitleFollow = createDesignTitleFollow({
  canvases: designCanvasStore,
  titleOf: async (chatId) => (await chatStore.getMeta(chatId))?.title,
  broadcast: broadcastDesignCanvasUpdate,
  onError: (error) => logger.warn("design", "Could not rename the chat's canvas page.", error),
});
chatStore.onTitleChanged((chatId) => void designTitleFollow.follow(chatId));

/**
 * Each chat's canvas view (page, viewports, the latest Aiden page change), as
 * its canvas reports it and Aiden's tools change it. Persisted per workspace
 * under `userData/design-canvas-views/`; whether a canvas is open is memory only.
 */
export const designCanvasViews = new DesignCanvasViews({
  root: () => path.join(app.getPath("userData"), "design-canvas-views"),
  onError: (error) => logger.warn("design", "Could not read or save design canvas views.", error),
});

/** What a deleted chat leaves on its workspace's canvas: its comments and its view go, the canvas stays. */
export const designCanvasChatCleanup = createDesignChatCleanup({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
  broadcast: broadcastDesignCanvasUpdate,
});

/** A No workspace chat attached with its files copied brings its canvas pages along. */
export const designCanvasCarry = createDesignCanvasCarry({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
  broadcast: broadcastDesignCanvasUpdate,
  newId: randomUUID,
  isLive: designLiveChats,
});

/** A removed workspace's canvas, its corrupt copies, its chats' views of it, and its running apps. */
export const designCanvasWorkspaceCleanup = createDesignWorkspaceCleanup({
  store: designWorkspaceCanvasStore,
  views: designCanvasViews,
  apps: {
    forgetWorkspace: async (workspaceId) => {
      await designAppServers.forgetWorkspace(workspaceId);
      // Live app frames (S76): the workspace's app service workers go with it.
      await installedAppNetwork()?.forgetWorkspace(workspaceId);
    },
  },
});

/**
 * Removes a workspace's canvas files for paths that drop a workspace record
 * outside the workspace service (managed-worktree delete, and its recovery at
 * startup). The record is already gone, so a failure only leaves clutter.
 */
export async function removeDesignCanvasWorkspace(workspaceId: string): Promise<void> {
  await designCanvasWorkspaceCleanup.removeWorkspace(workspaceId).catch((error: unknown) => {
    logger.warn("design", "Could not remove the workspace's design canvas.", error);
  });
}

/** Live `aiden-design://` grants. Memory only: a restart ends every grant. */
export const designGrants = new DesignGrantRegistry();

/**
 * Reloads frames when their workspace files change. A chat is watched only
 * while it holds a grant for that folder, so turning design mode off, deleting
 * the chat or removing its workspace (each revokes the grant) also stops it.
 */
export const designFileWatcher = new DesignFileWatcher({
  onChange: (update) => ipcMain.broadcast(DESIGN_FILES_CHANGED_CHANNEL, update),
  allowed: (chatId, root) => designGrants.holds(chatId, root),
});

/** Consent cards for Aiden's `design_mode` enter requests. Memory only. */
export const designModeConsent = new DesignModeConsent();

/** Pending `canvas_read` snapshot requests. Memory only. */
export const designCanvasSnapshots = new DesignCanvasSnapshots();

/** Each chat's running design-mode entry, which its turn's canvas writes wait for. Memory only. */
export const designPendingEntries = new PendingEntries();

/** HTML pages each chat's replies wrote in this run, for opening design mode mid-reply. Memory only. */
export const recentWrittenPages = new RecentWrittenPages();

/**
 * The DESIGN.md linter. Lazy: no worker starts until the first check, and the
 * linter itself loads only inside that worker, never on the main thread.
 */
export const designMdLinter: typeof runDesignMdWorker = (request, options = {}) =>
  runDesignMdWorker(request, {
    log: (message) => logger.warn("design", message),
    ...options,
  });

/** Each app's DESIGN.md, linted once per change in this run. Memory only. */
export const designMdReader = new DesignMdReader({
  run: designMdLinter,
  report: reportAnalyticsEvent,
  log: (message) => logger.warn("design", message),
});

/** Workspaces and app roots already offered a DESIGN.md draft (HMACs only). */
export const designMdOffers = new DesignMdOffers({
  file: () => path.join(app.getPath("userData"), "design-md-offers.json"),
  onSaveError: (error) => logger.warn("design", "Could not record the DESIGN.md offer.", error),
});

/** The app roots each workspace's design turns describe, cached on its manifests. Memory only. */
export const designAppRoots = createDesignAppRoots();

// ── Live apps (design mode v2, Phase 2b) ──

/** Run-app cards waiting for an answer. Memory only. */
export const designAppConsent = new DesignAppConsent();

/**
 * The background jobs service and its design-job events, connected by
 * main/index.ts: llm-client imports this file and loads follow-through-main
 * lazily, so this file must not import it.
 */
let connectedJobs: DesignAppJobs | undefined;
/** 2c: whose processes are Aiden's (D6), connected with the jobs so this file imports neither service. */
let connectedOwners: { ownedPids(rows: readonly ProcessRow[]): ReadonlySet<number>; terminalShellPids(): readonly number[] } | undefined;
const designJobListeners = new Set<(view: DesignJobView) => void>();
let settleRecovery: (ready: boolean) => void = () => undefined;
const designAppRecovery = new Promise<boolean>((resolve) => {
  settleRecovery = resolve;
});

export function connectDesignAppJobs(source: {
  jobs: DesignAppJobs;
  onJobChange(listener: (view: DesignJobView) => void): () => void;
  ownedPids(rows: readonly ProcessRow[]): ReadonlySet<number>;
  terminalShellPids(): readonly number[];
}): void {
  if (connectedJobs) return;
  connectedJobs = source.jobs;
  connectedOwners = { ownedPids: (rows) => source.ownedPids(rows), terminalShellPids: () => source.terminalShellPids() };
  source.onJobChange((view) => {
    for (const listener of designJobListeners) listener(view);
  });
}

/** Startup reaped (or failed to reap) the last session's processes; apps start only after true. */
export function designAppRecoveryDone(ready: boolean): void {
  settleRecovery(ready);
}

function jobs(): DesignAppJobs {
  if (!connectedJobs) throw new Error("Background jobs are not ready yet.");
  return connectedJobs;
}

/**
 * E2E only: a shorter presence grace, from `AIDEN_E2E_DESIGN_APP_GRACE_MS`,
 * read only in an unpackaged build (as AIDEN_ANALYTICS_DEBUG is) and clamped
 * to 1–60 s. A packaged app always waits the full 60 s.
 */
function presenceGraceMs(): number {
  const raw = app.isPackaged ? undefined : process.env.AIDEN_E2E_DESIGN_APP_GRACE_MS;
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? Math.min(DESIGN_APP_PRESENCE_GRACE_MS, Math.max(1_000, Math.floor(value))) : DESIGN_APP_PRESENCE_GRACE_MS;
}

/** D6: ports never listed or attached: the fixed list, plus the dev renderer's port when one is set. */
function attachExcludedPorts(): ReadonlySet<number> {
  const ports = new Set(ATTACH_EXCLUDED_PORTS);
  const renderer = process.env.AIDEN_RENDERER_URL;
  if (renderer) {
    try {
      const port = Number(new URL(renderer).port);
      if (port > 0) ports.add(port);
    } catch {
      // Not a URL: there is no renderer port to keep out.
    }
  }
  return ports;
}

/**
 * The person's own servers (2c D6–D9). Building it reads nothing; the process
 * and socket tables are read only when the person opens Connect, picks a row,
 * or an attached server is watched. Without a uid (Windows) nothing attaches.
 */
function attachDeps(): DesignAppAttachDeps | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const owners = () => {
    // Fail closed: until main connects the jobs, Aiden can't tell its own processes apart.
    if (!connectedOwners) throw new Error("Background jobs are not ready yet.");
    return connectedOwners;
  };
  return designAppAttachDeps({
    reader: defaultSocketReaderDeps(),
    uid,
    self: process.pid,
    realpath: (target) => fs.realpath(target),
    lstat: (target) => fs.lstat(target),
    excludedPorts: attachExcludedPorts,
    ownedPids: (rows) => owners().ownedPids(rows),
    terminalShellPids: () => owners().terminalShellPids(),
  });
}

const designAppAttach = attachDeps();

/** Every workspace's design-mode dev servers. Construction does no I/O and starts nothing. */
export const designAppServers = new DesignAppServers({
  jobs: {
    startDesign: (input) => jobs().startDesign(input),
    stopDesign: (jobId) => jobs().stopDesign(jobId),
    getDesign: (jobId) => connectedJobs?.getDesign(jobId),
    designTail: (jobId) => connectedJobs?.designTail(jobId) ?? "",
    designSockets: (jobIds, roots) => (roots ? jobs().designSockets(jobIds, roots) : jobs().designSockets(jobIds)),
    readDesignLog: (jobId, options) => jobs().readDesignLog(jobId, options),
  },
  onJobChange: (listener) => {
    designJobListeners.add(listener);
    return () => designJobListeners.delete(listener);
  },
  detect: (workspaceRoot) => detectWebApp(workspaceRoot, { stopAt: os.homedir(), homeDir: os.homedir() }),
  readConfig: readCanvasConfig,
  saveConfigApp: saveCanvasConfigApp,
  toolchain: (detected) => resolveDesignToolchain(detected, { isPackaged: app.isPackaged, env: process.env }),
  fingerprint: readLaunchSurface,
  dirsUnchanged: launchDirsUnchanged,
  records: createDesignAppRecords(() => path.join(app.getPath("userData"), "design-apps.json")),
  choosePort: (input) => chooseAppPort(input),
  osPort: defaultOsPort,
  consent: designAppConsent,
  views: designCanvasViews,
  workspace: async (workspaceId) => {
    const workspace = await configStore.getWorkspace(workspaceId);
    if (!workspace) return undefined;
    return { id: workspace.id, ...(workspace.folderPath ? { path: workspace.folderPath } : {}), permission: workspace.permission };
  },
  gate: workspaceMutationGate,
  recoveryReady: designAppRecovery,
  launchEnv: () => {
    const env = agentShellCommandEnvironment();
    // pi-ai reads only set variables; every provider key name it finds is scrubbed (D7).
    const set = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    return { env, providerKeys: providerKeyNames(env, getProviders(), (provider) => findEnvKeys(provider, set)) };
  },
  report: (event) => reportAnalyticsEvent("design_app_started", event),
  enabled: () => designLiveEnabled(),
  log: (event, detail) => logger.warn("design", event, detail),
  limits: { graceMs: presenceGraceMs() },
  ...(designAppAttach ? { attach: designAppAttach } : {}),
  clearToolchainCache: clearAppToolchainCache,
  // 3d (S103): the design app offer reads only files: the folders, the root's workspace patterns and canvas.json.
  mockInputs: readMockInputs,
  scaffold: designAppScaffoldDeps(),
});

/** 3d (S102–S115): writing, placing and reporting a design app. Nothing here runs before the scaffold card's Allow. */
function designAppScaffoldDeps(): NonNullable<ConstructorParameters<typeof DesignAppServers>[0]["scaffold"]> {
  const nodeModules = e2eDesignAppNodeModules({ isPackaged: app.isPackaged, env: process.env });
  return {
    template: () => readTemplate(designAppTemplateDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })),
    config: (workspaceRoot, input) => firstMockConfig(workspaceRoot, input),
    draft: (workspaceRoot, source) => draftMockDesignMd(workspaceRoot, source, { reader: designMdReader }),
    write: (workspaceRoot, folder, files, options) => writeMockApp(workspaceRoot, folder, files, options),
    ...(nodeModules ? { afterWrite: (workspaceRoot: string, folder: string) => linkDesignAppNodeModules(workspaceRoot, folder, nodeModules) } : {}),
    invalidateRoots: (workspaceRoot) => designAppRoots.invalidate(workspaceRoot),
    placeHome: (input) =>
      placeMockHome(
        {
          chatId: input.chatId,
          workspaceId: input.workspaceId,
          workspaceRoot: input.workspaceRoot,
          appRoot: input.appRoot,
          pages:
            "pages" in input.page
              ? input.page.pages
              : designTurnPages({ views: designCanvasViews, chatId: input.chatId, message: { selection: [], pageId: input.page.pageId } }),
        },
        {
          store: designCanvasStore,
          broadcast: broadcastDesignCanvasUpdate,
          newId: randomUUID,
          isLive: designLiveChats,
          inDesignMode: async (chatId) => (await chatStore.getMeta(chatId))?.designMode === true,
          focus: (request) => {
            const owner = input.owner;
            if (!owner || owner.isDestroyed()) return;
            try {
              owner.send("designCanvas:focus", { ...request, ...(input.by === "person" ? { own: true } : {}) });
            } catch {
              // The window went away; the frame is placed.
            }
          },
          // S115, call site 7: the design app's `/`, after the store commit.
          onAppFrameAdded: (width) => reportAnalyticsEvent("design_app_frame_added", { source: input.by, device_bucket: deviceBucket(width) }),
        },
      ),
    report: (event) => reportAnalyticsEvent("design_app_scaffolded", event),
    reportDrafted: () => reportAnalyticsEvent("design_md_drafted", { source: "mock" }),
  };
}

// Every window hears each workspace's app status; it carries no output beyond a crash's bounded tail.
designAppServers.onStatus((snapshot) => ipcMain.broadcast("designApp:status", snapshot));
// D12: running design apps, started and attached, lead the browser panel's Local servers.
designAppServers.onStatus((snapshot) => browserService.setDesignServers(snapshot.workspaceId, designBrowserServers(snapshot)));
