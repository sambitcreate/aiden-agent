import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  logger,
  powerMonitor,
  registerNativeHandlers,
  shell,
} from "./platform.js";
import { Menu, nativeImage, nativeTheme } from "electron";
import path from "node:path";

import { registerHandlers } from "./handlers/index.js";
import { terminalService } from "./services/terminal.js";
import { TerminalHistoryStore } from "./services/terminal-history.js";
import { getPreloadPath, getWindowUrl } from "./windows/window-paths.js";
import {
  initShortcut,
  initDictationShortcut,
  initAssistantShortcut,
  applyShortcutFromSettings,
  disposeShortcut,
  initShortcutBindingsChanged,
} from "./services/shortcut.js";
import { mcpManager } from "./services/mcp.js";
import {
  disposeFoundationModelsConnection,
  foundationModelsConnection,
} from "./services/foundation-models-connection.js";
import { configStore } from "./services/config-store.js";
import { skillRegistry } from "./services/skill-registry-main.js";
import { reloadPortableConfig } from "./services/portable-config.js";
import {
  createLastSafeSnapshotReload,
  createPortableConfigWatcher,
} from "./services/portable-config-watch-core.js";
import { setPortableCredentialSnapshotListener } from "./services/portable-credential-snapshot.js";
import {
  normalizeAppearanceConfig,
  type DockIconPreference,
} from "../renderer/shared/appearance.js";
import { shutdownProviderAuthFlow } from "./services/provider-auth-flow.js";
import { llmClient } from "./services/llm-client.js";
import { computerUseStatus } from "./services/computer-use/status.js";
import { computerUseSettings } from "./services/computer-use/settings.js";
import { closeRendererBeforeShutdown } from "./services/quit-barrier.js";
import { disposeDictation, toggleDictation } from "./services/dictation.js";
import { disposeParakeet } from "./services/parakeet.js";
import { isPackagedRuntime } from "./runtime-mode.js";
import { currentRuntimeProfile } from "./runtime-profile.js";
import { appUpdateService } from "./services/app-updater.js";
import type {
  AppUpdateCheckResult,
  AppUpdateRestartResult,
} from "../renderer/shared/app-update.js";
import { devLogPath } from "./services/dev-log.js";
import { scheduleService } from "./services/schedule-service.js";
import { telegramService } from "./services/telegram/telegram-service.js";
import { registerAppPathOpener } from "./services/app-navigation.js";
import {
  effectiveBindings,
  migrateLegacyKeybindings,
} from "../renderer/shared/keybindings.js";
import type { NotificationChannel } from "../renderer/preload-channels.js";
import type { AppSettings, Chat } from "./services/types.js";
import { ONBOARDING_COMPLETE_STORAGE_KEY } from "../renderer/shared/onboarding.js";
import { createRendererReadinessGate } from "./services/renderer-readiness-core.js";
import { createSupersedingTaskGate } from "./services/superseding-task-core.js";
import { subagentRuntimeRegistry } from "./services/subagents/child-agent-runtime.js";
import { subagentHealthMetrics } from "./services/subagents/subagent-health-metrics.js";
import {
  loadSubagentPackagedSoakSession,
  SUBAGENT_PACKAGED_SOAK_CHAT_ID,
  SUBAGENT_PACKAGED_SOAK_CHAT_PATH,
  requiresSubagentPackagedSoakFailureExit,
  subagentPackagedSoakAction,
  tryFinalizeSubagentPackagedSoakQuitReceipt,
  writeSubagentPackagedSoakReceipt,
  type SubagentPackagedSoakSession,
} from "./services/subagents/subagent-packaged-soak-core.js";
import { subagentsEnabled } from "./services/subagents/feature-flag.js";
import { piRuntimeEffectStore } from "./services/pi-runtime-effect-store.js";
import { displayImageArtifactStore } from "./services/display-image-artifact-store.js";
import { subagentRunStore } from "./services/subagents/subagent-run-store.js";
import { chatStore } from "./services/chat-store.js";
import {
  gitDeleteManagedWorktree,
  gitFinalizeManagedWorktreeDeletion,
  gitFinalizeOrphanedManagedWorktreeDeletionJournals,
  gitManagedWorktreeDeletionPending,
} from "./services/git.js";
import { reconcilePendingManagedWorktreeDeletions } from "./services/managed-worktree-deletion-recovery.js";
import { reconcilePendingChatDeletions } from "./services/chat-deletion-reconciliation.js";
import { ensureUserDataDir } from "./services/data-store.js";
import { piCompactionSessionStore } from "./services/pi-compaction-session-store.js";
import {
  reconcileExternalProviderCredentialChanges,
  reconcilePendingProviderCredentialRotation,
} from "./services/provider-credential-rotation.js";
import {
  reconcileExternalMcpCredentialChanges,
  reconcilePendingMcpCredentialCleanup,
} from "./services/mcp-credential-cleanup.js";
import { resetOnboardingData } from "./services/onboarding-reset.js";

const ownsSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | null = null;
const mainWindowLoads = createSupersedingTaskGate();
const rendererReadiness = createRendererReadinessGate();
let resolveShortcutInitialization: (() => void) | null = null;
const shortcutInitializationPromise = new Promise<void>((resolve) => {
  resolveShortcutInitialization = resolve;
});
let closeGuard = {
  dirty: false,
  gitBusy: false,
  path: undefined as string | undefined,
  saving: false,
};
let protectedAction: "close" | "quit" | "reload" | "onboarding-reset" | null =
  null;
let forceAppQuit = false;
let cleanupStarted = false;
let lifecycleCheckInFlight = false;
let shutdownStarted = false;
let installUpdateOnQuit = false;
let pendingPackagedSubagentSoakReceipt: SubagentPackagedSoakSession | undefined;
const disposeAppUpdateStateSubscription = appUpdateService.subscribe(
  (snapshot) => {
    ipcMain.broadcast("app:update-state", snapshot);
  },
);

const SUBAGENT_PACKAGED_SOAK_WAIT_MS = 30_000;
const SUBAGENT_PACKAGED_SOAK_POLL_MS = 25;

// These scripts are fixed at build time. The strict one-shot control record
// selects only among their named actions; it never supplies a selector, route,
// prompt, or JavaScript source.
const SUBAGENT_PACKAGED_SOAK_SEND_SCRIPT = `(() => {
  const input = document.querySelector("textarea");
  const send = document.querySelector('button[aria-label="Send message"]');
  if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement)) return false;
  const prompt = "Run the fixed subagent lifecycle probe.";
  // The composer starts with a disabled Send button. Fill it first, then let
  // React commit the input event before a later fixed poll performs the click.
  if (input.value !== prompt) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(input, prompt);
    else input.value = prompt;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return false;
  }
  if (send.disabled) return false;
  send.click();
  return true;
})()`;

const SUBAGENT_PACKAGED_SOAK_STOP_SCRIPT = `(() => {
  const stop = document.querySelector('button[aria-label="Stop generating"]');
  if (!(stop instanceof HTMLButtonElement) || stop.disabled) return false;
  stop.click();
  return true;
})()`;

const SUBAGENT_PACKAGED_SOAK_SETTINGS_VISIBLE_SCRIPT =
  "Boolean(document.querySelector('nav[aria-label=\"Settings\"]'))";

// The failure callout is the renderer's own generation error. This fixed,
// test-only reader makes a failed packaged smoke actionable without exposing
// an automation surface or accepting any caller-controlled selector.
const SUBAGENT_PACKAGED_SOAK_GENERATION_ERROR_SCRIPT = `(() => {
  const prefix = "Generation failed";
  const error = Array.from(document.querySelectorAll("div"))
    .map((element) => element.textContent?.trim() ?? "")
    .filter((text) => text.startsWith(prefix) && text.length > prefix.length)
    .sort((left, right) => left.length - right.length)[0];
  return error ? error.slice(prefix.length).trim() : null;
})()`;

function resetRendererReadiness(): void {
  rendererReadiness.reset();
}

function hasCloseGuard(): boolean {
  return closeGuard.dirty || closeGuard.gitBusy || closeGuard.saving;
}

function confirmProtectedAction(
  window: BrowserWindow,
  action: "close" | "reload",
): boolean {
  if (closeGuard.gitBusy) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "Git operation in progress",
      message: `Wait for the current Git operation to finish before ${action === "close" ? "closing Aiden" : "reloading"}.`,
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
  if (closeGuard.saving) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "File save in progress",
      message: `Wait for the open file to finish saving before ${action === "close" ? "closing Aiden" : "reloading"}.`,
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return false;
  }
  if (!closeGuard.dirty) return true;
  const response = dialog.showMessageBoxSync(window, {
    type: "warning",
    title: "Discard unsaved edits?",
    message: closeGuard.path
      ? `“${closeGuard.path}” has edits that have not been saved.`
      : "The open file has edits that have not been saved.",
    detail:
      action === "close"
        ? "Closing Aiden will permanently discard those edits."
        : "Reloading Aiden will permanently discard those edits.",
    buttons: [
      "Keep Editing",
      action === "close"
        ? "Discard Edits and Close"
        : "Discard Edits and Reload",
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

function cleanupApplication(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  disposeAppUpdateStateSubscription();
  appUpdateService.dispose();
  disposeShortcut();
  disposeDictation();
  disposeParakeet();
  disposeFoundationModelsConnection();
  computerUseStatus.invalidate();
  scheduleService.stop();
  llmClient.abortAll();
  telegramService.stop();
  subagentRuntimeRegistry.abortAll();
  void mcpManager.closeAll();
}

async function shutdownAndQuit(settingsPrepared = false): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (!settingsPrepared) {
    try {
      await computerUseSettings.shutdown();
    } catch (error) {
      shutdownStarted = false;
      computerUseSettings.resumeAfterCancelledShutdown();
      logger.error(
        "main",
        "Computer Use state was not durable; Aiden will stay open.",
        error,
      );
      return;
    }
  }
  // Settle parent generations before registry teardown. A child can still be
  // constructing tools before it is registered, and its bounded drain must
  // record any cleanup miss before a packaged-soak receipt is written.
  llmClient.abortAll();
  let parentSettled = false;
  try {
    parentSettled = await llmClient.shutdown();
    if (!parentSettled) {
      logger.warn(
        "main",
        "Parent generation did not settle before the shutdown deadline; forcing application shutdown.",
      );
    }
  } catch (error) {
    logger.error(
      "main",
      "Parent generation shutdown did not complete cleanly.",
      error,
    );
  }
  const subagentsSettled = await subagentRuntimeRegistry.shutdown();
  if (!subagentsSettled) {
    logger.warn(
      "main",
      "Subagent work did not settle before the shutdown deadline; forcing application shutdown.",
    );
  }
  const session = pendingPackagedSubagentSoakReceipt;
  pendingPackagedSubagentSoakReceipt = undefined;
  const quitReceiptFinalization =
    await tryFinalizeSubagentPackagedSoakQuitReceipt(
      session,
      parentSettled,
      subagentsSettled,
      {
        flushMetrics: () => subagentHealthMetrics.flush(),
        snapshotMetrics: () => subagentHealthMetrics.snapshotForPackagedSoak(),
        writeReceipt: writeSubagentPackagedSoakReceipt,
      },
    );
  if (quitReceiptFinalization.status === "lifecycle_unsettled") {
    logger.warn(
      "main",
      "Skipping packaged subagent soak quit receipt because lifecycle teardown was incomplete.",
    );
  } else if (quitReceiptFinalization.status === "timed_out") {
    logger.warn(
      "main",
      "Packaged subagent soak receipt finalization exceeded its shutdown budget; continuing without a receipt.",
    );
  } else if (quitReceiptFinalization.status === "failed") {
    logger.error(
      "main",
      "Packaged subagent soak metrics or receipt could not be finalized; continuing shutdown without a receipt.",
      quitReceiptFinalization.error,
    );
  }
  if (
    requiresSubagentPackagedSoakFailureExit(session, quitReceiptFinalization)
  ) {
    logger.error(
      "main",
      "Packaged subagent soak finalization did not create a valid receipt; exiting with failure.",
    );
    // Do not let later asynchronous cleanup give a timed-out receipt writer
    // time to publish evidence after its lifecycle has already failed closed.
    app.exit(1);
    return;
  }
  cleanupApplication();
  try {
    await Promise.all([
      shutdownProviderAuthFlow(),
      computerUseStatus.shutdown(),
      scheduleService.stopAndSettle(),
      telegramService.stopAndSettle(),
      (async () => {
        await subagentRunStore.flush();
        await subagentRunStore.close();
      })(),
      terminalService.flushHistory(),
    ]);
  } catch (error) {
    logger.error(
      "main",
      "Application service shutdown did not complete cleanly.",
      error,
    );
  }
  forceAppQuit = true;
  if (installUpdateOnQuit) {
    installUpdateOnQuit = false;
    if (appUpdateService.installDownloadedUpdateAndRestart()) return;
    logger.error(
      "updater",
      "The update installer did not start after shutdown; falling back to a normal quit.",
    );
  }
  app.quit();
}

async function refreshCloseGuardFromRenderer(
  window: BrowserWindow,
): Promise<number | null> {
  try {
    const latest = (await window.webContents.executeJavaScript(
      `({
        dirty: document.documentElement.dataset.aidenDirty === "1",
        gitBusy: document.documentElement.dataset.aidenGitBusy === "1",
        revision: Number(document.documentElement.dataset.aidenGuardRevision || "0"),
        saving: document.documentElement.dataset.aidenSaving === "1"
      })`,
      true,
    )) as {
      dirty?: unknown;
      gitBusy?: unknown;
      revision?: unknown;
      saving?: unknown;
    };
    closeGuard = {
      dirty: latest?.dirty === true,
      gitBusy: latest?.gitBusy === true,
      path: closeGuard.path,
      saving: latest?.saving === true,
    };
    return Number.isSafeInteger(latest?.revision) &&
      Number(latest.revision) >= 0
      ? Number(latest.revision)
      : 0;
  } catch (error) {
    logger.warn("main", "Could not confirm the renderer close guard", error);
    if (!window.isDestroyed()) {
      dialog.showMessageBoxSync(window, {
        type: "info",
        title: "Aiden is still checking this window",
        message:
          "Aiden could not confirm whether an editor or Git operation is still active. Keep the window open and try again.",
        buttons: ["Keep Aiden Open"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    }
    return null;
  }
}

async function armRendererUnload(
  window: BrowserWindow,
  revision: number,
): Promise<boolean> {
  try {
    return (
      (await window.webContents.executeJavaScript(
        `(() => {
        const root = document.documentElement;
        if (Number(root.dataset.aidenGuardRevision || "0") !== ${revision}) return false;
        root.dataset.aidenApprovedGuardRevision = String(${revision});
        return true;
      })()`,
        true,
      )) === true
    );
  } catch (error) {
    logger.warn("main", "Could not arm the renderer unload guard", error);
    return false;
  }
}

async function authorizeProtectedAction(
  window: BrowserWindow,
  action: "close" | "reload",
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await refreshCloseGuardFromRenderer(window);
    if (revision === null) return false;
    if (hasCloseGuard() && !confirmProtectedAction(window, action))
      return false;
    if (await armRendererUnload(window, revision)) return true;
  }
  if (!window.isDestroyed()) {
    dialog.showMessageBoxSync(window, {
      type: "info",
      title: "Aiden is still updating this window",
      message:
        "The editor or Git state changed while Aiden prepared this action. Keep the window open and try again.",
      buttons: ["Keep Aiden Open"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }
  return false;
}

async function requestWindowClose(window: BrowserWindow): Promise<void> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return;
  lifecycleCheckInFlight = true;
  try {
    if (!(await authorizeProtectedAction(window, "close"))) return;
    protectedAction = "close";
    window.close();
  } finally {
    lifecycleCheckInFlight = false;
  }
}

async function requestWindowReload(
  window: BrowserWindow,
  options: { ignoreCache?: boolean } = {},
): Promise<void> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return;
  lifecycleCheckInFlight = true;
  try {
    if (!(await authorizeProtectedAction(window, "reload"))) return;
    closeGuard = {
      dirty: false,
      gitBusy: false,
      path: undefined,
      saving: false,
    };
    protectedAction = "reload";
    if (options.ignoreCache) window.webContents.reloadIgnoringCache();
    else window.webContents.reload();
  } finally {
    lifecycleCheckInFlight = false;
  }
}

async function requestApplicationQuit(window: BrowserWindow): Promise<boolean> {
  if (lifecycleCheckInFlight || window.isDestroyed()) return false;
  lifecycleCheckInFlight = true;
  try {
    if (!(await authorizeProtectedAction(window, "close"))) return false;
    try {
      await computerUseSettings.shutdown();
    } catch (error) {
      computerUseSettings.resumeAfterCancelledShutdown();
      logger.error(
        "main",
        "Computer Use state was not durable; quit was cancelled.",
        error,
      );
      if (!window.isDestroyed()) {
        dialog.showMessageBoxSync(window, {
          type: "error",
          title: "Aiden couldn't save Computer Use",
          message:
            "Aiden will stay open because Computer Use could not be safely turned off.",
          detail:
            "Check that the app can write its settings, then try quitting again.",
          buttons: ["Keep Aiden Open"],
          defaultId: 0,
          noLink: true,
        });
      }
      return false;
    }
    protectedAction = "quit";
    if (!(await closeRendererBeforeShutdown(window))) {
      protectedAction = null;
      computerUseSettings.resumeAfterCancelledShutdown();
      return false;
    }
    await shutdownAndQuit(true);
    return shutdownStarted;
  } finally {
    lifecycleCheckInFlight = false;
    if (!shutdownStarted && installUpdateOnQuit) {
      installUpdateOnQuit = false;
      appUpdateService.announceSnapshot();
    }
  }
}

async function clearRendererOnboardingCompletion(
  window: BrowserWindow,
): Promise<boolean> {
  try {
    return (
      (await window.webContents.executeJavaScript(
        `(() => {
          const key = ${JSON.stringify(ONBOARDING_COMPLETE_STORAGE_KEY)};
          const wasComplete = localStorage.getItem(key) === "true";
          localStorage.removeItem(key);
          return wasComplete;
        })()`,
        true,
      )) === true
    );
  } catch (error) {
    logger.error(
      "main",
      "Could not clear the onboarding completion marker.",
      error,
    );
    throw new Error(
      "Aiden couldn’t prepare onboarding for restart. Try again.",
    );
  }
}

async function restoreRendererOnboardingCompletion(
  window: BrowserWindow,
  wasComplete: boolean,
): Promise<void> {
  if (!wasComplete || window.isDestroyed()) return;
  try {
    await window.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(ONBOARDING_COMPLETE_STORAGE_KEY)}, "true")`,
      true,
    );
  } catch (error) {
    logger.error(
      "main",
      "Could not restore the onboarding completion marker.",
      error,
    );
  }
}

async function requestOnboardingReset(window: BrowserWindow): Promise<boolean> {
  if (
    lifecycleCheckInFlight ||
    shutdownStarted ||
    installUpdateOnQuit ||
    window.isDestroyed()
  ) {
    return false;
  }
  lifecycleCheckInFlight = true;
  let settingsPrepared = false;
  try {
    if (!(await authorizeProtectedAction(window, "close"))) return false;
    try {
      await computerUseSettings.shutdown();
      settingsPrepared = true;
    } catch (error) {
      computerUseSettings.resumeAfterCancelledShutdown();
      logger.error(
        "main",
        "Computer Use state was not durable; onboarding reset was cancelled.",
        error,
      );
      if (!window.isDestroyed()) {
        dialog.showMessageBoxSync(window, {
          type: "error",
          title: "Aiden couldn't save Computer Use",
          message:
            "Onboarding was not reset because Computer Use could not be safely turned off.",
          detail: "Check that the app can write its settings, then try again.",
          buttons: ["Keep Aiden Open"],
          defaultId: 0,
          noLink: true,
        });
      }
      return false;
    }

    const onboardingWasComplete =
      await clearRendererOnboardingCompletion(window);
    protectedAction = "onboarding-reset";
    if (!(await closeRendererBeforeShutdown(window))) {
      protectedAction = null;
      await restoreRendererOnboardingCompletion(window, onboardingWasComplete);
      computerUseSettings.resumeAfterCancelledShutdown();
      return false;
    }

    try {
      await resetOnboardingData();
    } catch (error) {
      computerUseSettings.resumeAfterCancelledShutdown();
      settingsPrepared = false;
      protectedAction = null;
      logger.error(
        "main",
        "Onboarding reset was incomplete after the renderer closed.",
        error,
      );
      try {
        await createMainWindow();
      } catch (recoveryError) {
        logger.error(
          "main",
          "Could not reopen Aiden after an incomplete onboarding reset.",
          recoveryError,
        );
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBoxSync(mainWindow, {
          type: "error",
          title: "Aiden couldn't finish the reset",
          message:
            "Some setup data could not be cleared. Retry Reset onboarding.",
          detail:
            "Aiden reopened without deleting your chats, projects, schedules, or skills.",
          buttons: ["Keep Aiden Open"],
          defaultId: 0,
          noLink: true,
        });
      } else {
        dialog.showErrorBox(
          "Aiden couldn't finish the reset",
          "Some setup data could not be cleared. Reopen Aiden and retry Reset onboarding.",
        );
      }
      return false;
    }

    app.relaunch();
    await shutdownAndQuit(true);
    return shutdownStarted;
  } catch (error) {
    if (settingsPrepared) computerUseSettings.resumeAfterCancelledShutdown();
    throw error;
  } finally {
    lifecycleCheckInFlight = false;
  }
}

ipcMain.handle("app:setCloseGuard", (event, value: unknown) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id
  )
    return false;
  const input = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  closeGuard = {
    dirty: input.dirty === true,
    gitBusy: input.gitBusy === true,
    path:
      typeof input.path === "string" && input.path.length <= 4_096
        ? input.path
        : undefined,
    saving: input.saving === true,
  };
  return true;
});

ipcMain.handle("app:resetOnboarding", async (event) => {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    event.sender.id !== window.webContents.id
  )
    return false;
  return requestOnboardingReset(window);
});

ipcMain.handle("app:getUpdateState", (event) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id
  ) {
    return {
      status: "idle",
      version: null,
    };
  }
  return appUpdateService.snapshot();
});

ipcMain.handle(
  "app:checkForUpdates",
  async (event): Promise<AppUpdateCheckResult> => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender.id !== mainWindow.webContents.id
    ) {
      return { outcome: "unavailable" };
    }
    return appUpdateService.checkNow(false);
  },
);

ipcMain.handle("app:restartToUpdate", (event): AppUpdateRestartResult => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id
  ) {
    return {
      accepted: false,
      reason: "unavailable",
    };
  }
  if (lifecycleCheckInFlight || shutdownStarted) {
    return {
      accepted: false,
      reason: "busy",
    };
  }
  if (!appUpdateService.canInstallDownloadedUpdate()) {
    return {
      accepted: false,
      reason: "not-ready",
    };
  }

  const window = mainWindow;
  installUpdateOnQuit = true;
  setImmediate(() => void requestApplicationQuit(window));
  return {
    accepted: true,
  };
});

ipcMain.handle("app:renderer-ready", (event) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id
  )
    return false;
  rendererReadiness.markReady();
  return true;
});

async function applyDockIconPreference(
  preference: DockIconPreference,
): Promise<boolean> {
  if (process.platform !== "darwin" || !app.dock) return false;
  const iconPath =
    preference === "monochrome"
      ? isPackagedRuntime()
        ? path.join(process.resourcesPath, "app-icon-monochrome.png")
        : path.join(app.getAppPath(), "resources", "app-icon-monochrome.png")
      : isPackagedRuntime()
        ? path.join(process.resourcesPath, "app-icon.png")
        : path.join(app.getAppPath(), "resources", "app-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty())
    throw new Error(`Dock icon is unavailable: ${path.basename(iconPath)}`);
  app.dock.setIcon(icon);
  await app.dock.show();
  return true;
}

async function restoreDockIconPreference(
  preference: DockIconPreference,
): Promise<void> {
  try {
    await applyDockIconPreference(preference);
  } catch (error) {
    logger.warn("main", "Could not restore the saved Dock icon", error);
    if (preference === "aiden") return;
    try {
      await applyDockIconPreference("aiden");
    } catch (fallbackError) {
      logger.warn(
        "main",
        "Could not restore the default Dock icon",
        fallbackError,
      );
    }
  }
}

ipcMain.handle("app:setDockIcon", async (event, value: unknown) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.id !== mainWindow.webContents.id
  )
    return false;
  if (value !== "aiden" && value !== "monochrome")
    throw new Error("Invalid Dock icon preference.");
  return applyDockIconPreference(value);
});

function openExternalUrl(value: string): void {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "mailto:"
    ) {
      void shell.openExternal(url.toString());
    }
  } catch {
    logger.warn("main", "Blocked invalid external URL", { value });
  }
}

async function createMainWindow(): Promise<void> {
  // macOS activate, a second-instance event, or a newly registered global
  // shortcut can all arrive while whenReady is still initializing. Never let
  // those alternate paths expose a renderer to a partial shortcut snapshot.
  await shortcutInitializationPromise;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const existingWindow = mainWindow;
    await mainWindowLoads.wait();
    if (existingWindow.isDestroyed() || mainWindow !== existingWindow) return;
    existingWindow.show();
    existingWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 390,
    minHeight: 456,
    title: app.getName(),
    titleBarStyle: "hiddenInset",
    // Center the 12px macOS window controls in the renderer's 52px top bar.
    trafficLightPosition: { x: 14, y: 20 },
    backgroundColor: "#00000000",
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  resetRendererReadiness();

  const createdWindow = mainWindow;
  const createdWebContentsId = createdWindow.webContents.id;
  const mainWindowUrl = getWindowUrl("main-window.html");
  createdWindow.webContents.on("did-start-loading", () => {
    resetRendererReadiness();
    terminalService.closeForWebContents(createdWebContentsId);
  });
  createdWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error("renderer-lifecycle", "Main renderer process exited", {
      webContentsId: createdWebContentsId,
      reason: details.reason,
      exitCode: details.exitCode,
      cleanupStarted,
      shutdownStarted,
    });
    rendererReadiness.reset();
    terminalService.closeForWebContents(createdWebContentsId);
    if (
      cleanupStarted ||
      shutdownStarted ||
      createdWindow.isDestroyed() ||
      mainWindow !== createdWindow
    )
      return;
    const recovery = mainWindowLoads.replace(
      createdWindow.loadURL(mainWindowUrl),
    );
    void recovery.promise.catch((error: unknown) => {
      if (!mainWindowLoads.isCurrent(recovery)) return;
      logger.error(
        "main",
        "Could not recover the main renderer after it exited.",
        error,
      );
      if (!createdWindow.isDestroyed()) createdWindow.destroy();
    });
  });
  createdWindow.webContents.on("unresponsive", () => {
    logger.warn("renderer-lifecycle", "Main renderer became unresponsive", {
      webContentsId: createdWebContentsId,
      url: createdWindow.webContents.getURL(),
    });
  });
  createdWindow.webContents.on("responsive", () => {
    logger.info("renderer-lifecycle", "Main renderer became responsive", {
      webContentsId: createdWebContentsId,
    });
  });
  createdWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logger.error("renderer-lifecycle", "Renderer load failed", {
        webContentsId: createdWebContentsId,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    },
  );
  createdWindow.webContents.on(
    "preload-error",
    (_event, preloadPath, error) => {
      logger.error(
        "renderer-lifecycle",
        "Renderer preload failed",
        { webContentsId: createdWebContentsId, preloadPath },
        error,
      );
    },
  );
  createdWindow.once("ready-to-show", () => createdWindow.show());
  createdWindow.on("close", (event) => {
    if (
      protectedAction === "close" ||
      protectedAction === "quit" ||
      protectedAction === "onboarding-reset"
    )
      return;
    event.preventDefault();
    void requestWindowClose(createdWindow);
  });
  createdWindow.on("closed", () => {
    terminalService.closeForWebContents(createdWebContentsId);
    if (mainWindow === createdWindow) {
      mainWindow = null;
      mainWindowLoads.clear();
      rendererReadiness.dispose();
    }
    closeGuard = {
      dirty: false,
      gitBusy: false,
      path: undefined,
      saving: false,
    };
    protectedAction = null;
  });

  createdWindow.webContents.on("will-prevent-unload", () => {
    // Never override a newer renderer veto. The approved lifecycle action is
    // retried against a fresh guard revision instead.
    const interruptedAction = protectedAction;
    protectedAction = null;
    if (interruptedAction === "onboarding-reset") {
      setImmediate(() => void requestOnboardingReset(createdWindow));
    } else if (interruptedAction === "quit") {
      forceAppQuit = false;
      shutdownStarted = false;
      setImmediate(() => void requestApplicationQuit(createdWindow));
    } else if (interruptedAction === "close") {
      setImmediate(() => void requestWindowClose(createdWindow));
    } else {
      setImmediate(() => void requestWindowReload(createdWindow));
    }
  });
  createdWindow.webContents.on("did-finish-load", () => {
    protectedAction = null;
  });

  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });
  createdWindow.webContents.on("will-navigate", (event, url) => {
    const current = createdWindow.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  createdWindow.webContents.on("will-redirect", (event, url) => {
    event.preventDefault();
    openExternalUrl(url);
  });

  logger.info("main", "Loading renderer", { url: mainWindowUrl });
  mainWindowLoads.replace(createdWindow.loadURL(mainWindowUrl));
  await mainWindowLoads.wait();
  if (createdWindow.isDestroyed() || mainWindow !== createdWindow) return;

  if (process.env.AIDEN_OPEN_DEVTOOLS === "1")
    createdWindow.webContents.openDevTools({ mode: "detach" });
}

async function deliverMainWindowNotification(
  channel: NotificationChannel,
  payload: Record<string, unknown>,
): Promise<void> {
  await createMainWindow();
  await rendererReadiness.wait();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  switch (channel) {
    case "app:command":
      ipcMain.broadcast("app:command", payload);
      break;
    case "app:navigate":
      ipcMain.broadcast("app:navigate", payload);
      break;
    default:
      // Keep delivery intentionally closed over the two main-window channels
      // above. A new call site must add a literal branch so the IPC inventory
      // contract detects it and requires the preload allowlist in the same diff.
      throw new Error(`Unsupported queued renderer channel: ${channel}`);
  }
}

function deliverMainWindowNotificationSafely(
  channel: NotificationChannel,
  payload: Record<string, unknown>,
): void {
  void deliverMainWindowNotification(channel, payload).catch(
    (error: unknown) => {
      logger.warn(
        "main",
        `Could not deliver renderer command "${channel}".`,
        error,
      );
    },
  );
}

function showMainWindow(): void {
  void createMainWindow().catch((error: unknown) => {
    logger.warn("main", "Could not show the main window.", error);
  });
}

function pauseForPackagedSubagentSoak(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, SUBAGENT_PACKAGED_SOAK_POLL_MS),
  );
}

async function waitForPackagedSubagentSoak(
  step: string,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + SUBAGENT_PACKAGED_SOAK_WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pauseForPackagedSubagentSoak();
  }
  throw new Error(`Packaged subagent soak did not reach ${step}.`);
}

async function runPackagedSubagentSoakRendererScript(
  script: string,
): Promise<boolean> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged subagent soak lost its main window.");
  }
  return (await window.webContents.executeJavaScript(script, true)) === true;
}

async function packagedSubagentSoakGenerationError(): Promise<string | null> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error("Packaged subagent soak lost its main window.");
  }
  const result = await window.webContents.executeJavaScript(
    SUBAGENT_PACKAGED_SOAK_GENERATION_ERROR_SCRIPT,
    true,
  );
  return typeof result === "string" && result ? result : null;
}

async function settlePackagedSubagentSoak(
  session: SubagentPackagedSoakSession,
): Promise<void> {
  if (!(await llmClient.waitForChatIdle(SUBAGENT_PACKAGED_SOAK_CHAT_ID))) {
    throw new Error(
      "Packaged subagent soak did not settle its parent generation.",
    );
  }
  await waitForPackagedSubagentSoak(
    "child settlement",
    () =>
      !subagentRuntimeRegistry.hasChatChildren(SUBAGENT_PACKAGED_SOAK_CHAT_ID),
  );
  await subagentHealthMetrics.flush();
  await writeSubagentPackagedSoakReceipt(
    session,
    await subagentHealthMetrics.snapshotForPackagedSoak(),
  );
  app.quit();
}

/**
 * Drives exactly one verified, opt-in packaged lifecycle. This is intentionally
 * main-only and fixed-function: normal users have no new IPC, renderer API, or
 * automation endpoint.
 */
async function runPackagedSubagentSoak(
  session: SubagentPackagedSoakSession,
): Promise<void> {
  await deliverMainWindowNotification("app:navigate", {
    path: SUBAGENT_PACKAGED_SOAK_CHAT_PATH,
  });
  await waitForPackagedSubagentSoak("composer readiness", () =>
    runPackagedSubagentSoakRendererScript(SUBAGENT_PACKAGED_SOAK_SEND_SCRIPT),
  );
  await waitForPackagedSubagentSoak("child start", async () => {
    const generationError = await packagedSubagentSoakGenerationError();
    if (generationError) {
      throw new Error(
        `Packaged subagent soak parent generation failed: ${generationError}`,
      );
    }
    return subagentRuntimeRegistry.hasChatChildren(
      SUBAGENT_PACKAGED_SOAK_CHAT_ID,
    );
  });
  // Ownership alone is intentionally insufficient: a child is registered
  // before it acquires a slot and dispatches provider work. Wait for Pi's
  // response callback so the loopback child request is actually in flight.
  await waitForPackagedSubagentSoak("child provider response", () =>
    subagentRuntimeRegistry.hasChatProviderResponse(
      SUBAGENT_PACKAGED_SOAK_CHAT_ID,
    ),
  );
  await waitForPackagedSubagentSoak(
    "aggregate child start",
    async () =>
      (await subagentHealthMetrics.snapshotForPackagedSoak()).starts === 1,
  );

  const action = subagentPackagedSoakAction(session.control.mode);
  switch (action.kind) {
    case "renderer_stop":
      await waitForPackagedSubagentSoak("user stop", () =>
        runPackagedSubagentSoakRendererScript(
          SUBAGENT_PACKAGED_SOAK_STOP_SCRIPT,
        ),
      );
      await settlePackagedSubagentSoak(session);
      return;
    case "main_navigate":
      await deliverMainWindowNotification("app:navigate", {
        path: action.path,
      });
      await waitForPackagedSubagentSoak("Settings navigation", () =>
        runPackagedSubagentSoakRendererScript(
          SUBAGENT_PACKAGED_SOAK_SETTINGS_VISIBLE_SCRIPT,
        ),
      );
      await settlePackagedSubagentSoak(session);
      return;
    case "normal_quit":
      pendingPackagedSubagentSoakReceipt = session;
      app.quit();
      return;
  }
}

registerAppPathOpener(async (path) => {
  await deliverMainWindowNotification("app:navigate", { path });
});

function setupApplicationMenu(
  settings: AppSettings,
  acceleratorsEnabled = true,
): void {
  if (!acceleratorsEnabled) {
    Menu.setApplicationMenu(null);
    return;
  }
  const bindings = effectiveBindings(
    migrateLegacyKeybindings(settings.keybindings, settings),
  );
  const command = (commandId: keyof typeof bindings) =>
    bindings[commandId] ?? undefined;
  const menu = Menu.buildFromTemplate([
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => void appUpdateService.checkNow(true),
        },
        { type: "separator" },
        {
          label: "Command Palette…",
          accelerator: command("commandPalette.toggle"),
          click: () =>
            deliverMainWindowNotificationSafely("app:command", {
              commandId: "commandPalette.toggle",
            }),
        },
        {
          label: "Settings…",
          accelerator: command("settings.open"),
          click: () =>
            deliverMainWindowNotificationSafely("app:command", {
              commandId: "settings.open",
            }),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: command("chat.new"),
          click: () =>
            deliverMainWindowNotificationSafely("app:command", {
              commandId: "chat.new",
            }),
        },
        {
          label: "Open Workspace in Preferred Editor",
          accelerator: command("workspace.openPreferredEditor"),
          click: () =>
            deliverMainWindowNotificationSafely("app:command", {
              commandId: "workspace.openPreferredEditor",
            }),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "Command+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed())
              void requestWindowReload(mainWindow);
          },
        },
        {
          label: "Force Reload",
          accelerator: "Command+Shift+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              void requestWindowReload(mainWindow, { ignoreCache: true });
            }
          },
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  registerNativeHandlers();
  registerHandlers();

  app.on("child-process-gone", (_event, details) => {
    logger.error(
      "electron-lifecycle",
      "Electron child process exited unexpectedly",
      details,
    );
  });

  app.on("second-instance", () => showMainWindow());
  app.on("window-all-closed", () => {
    logger.info("electron-lifecycle", "All application windows closed", {
      platform: process.platform,
    });
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    void foundationModelsConnection.status({ force: true });
    showMainWindow();
  });

  app.on("before-quit", (event) => {
    logger.info("electron-lifecycle", "Application before-quit", {
      forceAppQuit,
      shutdownStarted,
      lifecycleCheckInFlight,
      hasMainWindow: Boolean(mainWindow && !mainWindow.isDestroyed()),
    });
    if (forceAppQuit) return;
    event.preventDefault();
    if (shutdownStarted || lifecycleCheckInFlight) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void requestApplicationQuit(mainWindow);
    } else {
      void shutdownAndQuit();
    }
  });

  app.on("will-quit", () => {
    logger.info("electron-lifecycle", "Application will-quit");
    cleanupApplication();
  });
  app.on("quit", (_event, exitCode) => {
    logger.info("electron-lifecycle", "Application quit", { exitCode });
  });

  // Only a real content change reaches the renderer, and concurrent triggers
  // coalesce, which is what makes this affordable on every focus.
  async function portableCredentialSnapshot() {
    const [providers, mcpServers] = await Promise.all([
      configStore.listProviders(),
      configStore.listMcpServers(),
    ]);
    return { providers, mcpServers };
  }
  const reloadAndReconcilePortableConfig = createLastSafeSnapshotReload(
    () => configStore.cachedPortableConfigSafeForCredentialReconciliation(),
    portableCredentialSnapshot,
    reloadPortableConfig,
    async (previous, next) => {
      await Promise.all([
        reconcileExternalProviderCredentialChanges(
          previous.providers,
          next.providers,
        ),
        reconcileExternalMcpCredentialChanges(
          previous.mcpServers,
          next.mcpServers,
          (serverId) => mcpManager.disconnect(serverId),
        ),
      ]);
    },
  );
  setPortableCredentialSnapshotListener(() =>
    reloadAndReconcilePortableConfig.syncCurrent(),
  );
  const portableConfigWatcher = createPortableConfigWatcher(
    reloadAndReconcilePortableConfig,
    () => {
      skillRegistry.invalidate();
      ipcMain.broadcast("app:config-externally-changed", {});
    },
    (error: unknown) =>
      logger.warn(
        "portable-config",
        "Failed to re-read the portable config",
        error,
      ),
  );

  app
    .whenReady()
    .then(async () => {
      const runtimeProfile = currentRuntimeProfile();
      if (
        runtimeProfile.id === "development" &&
        process.platform === "darwin"
      ) {
        app.dock?.setBadge("DEV");
      }
      const packagedSubagentSoak = await loadSubagentPackagedSoakSession({
        isPackaged: isPackagedRuntime(),
      });
      if (packagedSubagentSoak && !subagentsEnabled()) {
        throw new Error(
          "Packaged subagent soak requires the internal subagent opt-in.",
        );
      }
      if (!isPackagedRuntime()) {
        logger.info(
          "dev-log",
          `Writing dev log to ${devLogPath() ?? "unknown"}`,
        );
        logger.info("electron-lifecycle", "Electron application ready", {
          appName: app.getName(),
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron,
          chromeVersion: process.versions.chrome,
          pid: process.pid,
          userDataPath: runtimeProfile.userDataPath,
          crashDumpsPath: runtimeProfile.crashDumpsPath,
        });
      }
      try {
        terminalService.installHistoryStore(
          await TerminalHistoryStore.create(),
        );
      } catch (error) {
        logger.warn(
          "terminal",
          "Persisted terminal history is unavailable; terminals will remain session-only.",
          error,
        );
      }
      // Reconcile every persisted active child at the actual restart boundary,
      // before a renderer can read or append run history.
      await piRuntimeEffectStore.initialize();
      await displayImageArtifactStore.initialize();
      const quarantinedImageArtifactPath = displayImageArtifactStore.quarantinedPath();
      if (quarantinedImageArtifactPath) {
        logger.warn(
          "pi",
          `Invalid image artifact staging was preserved at ${quarantinedImageArtifactPath}; Aiden opened a clean staging store.`,
        );
      }
      const displayImageArtifactAvailability = displayImageArtifactStore.availability();
      if (!displayImageArtifactAvailability.available) {
        logger.warn(
          "pi",
          "Image artifact recovery is unavailable; chat mutations will remain blocked.",
          new Error(displayImageArtifactAvailability.reason),
        );
      }
      await subagentRunStore.initialize();
      await reconcilePendingChatDeletions(subagentRunStore, async (chatId) => {
        if (displayImageArtifactAvailability.available) {
          await displayImageArtifactStore.deleteChat(chatId);
        }
        await piRuntimeEffectStore.deleteChat(chatId);
        await piCompactionSessionStore.deleteChat(chatId);
        await chatStore.remove(chatId);
      });
      if (displayImageArtifactAvailability.available) {
        try {
          const startupChats = (
            await Promise.all(
              (await displayImageArtifactStore.pendingChatIds()).map((chatId) =>
                chatStore.get(chatId),
              ),
            )
          ).filter((chat): chat is Chat => chat !== null);
          await displayImageArtifactStore.recover(
            startupChats,
            async ({ chatId, attachments, createdAt, model }) => {
              await chatStore.appendMessage(chatId, {
                role: "assistant",
                content: "",
                attachments,
                createdAt,
                model,
                providerFailure: {
                  version: 1,
                  category: "interrupted",
                  attempts: 1,
                  retryExhausted: false,
                },
              });
            },
          );
        } catch (error) {
          logger.warn(
            "pi",
            "Could not recover staged image artifacts; affected chats remain blocked.",
            error,
          );
        }
      }
      const visibleChatIds = new Set(
        (await chatStore.list()).map((chat) => chat.id),
      );
      await Promise.all([
        piRuntimeEffectStore.reconcileChats(visibleChatIds),
        piCompactionSessionStore.reconcileChats(visibleChatIds),
      ]);
      await reconcilePendingManagedWorktreeDeletions({
        listWorkspaces: () => configStore.listWorkspaces(),
        deletionPending: (workspace) => {
          const managed = workspace.managedWorktree;
          if (!managed?.worktreeGitDir || !managed.ownershipToken)
            return Promise.resolve(false);
          return gitManagedWorktreeDeletionPending(
            managed.worktreePath,
            managed.worktreeGitDir,
            managed.ownershipToken,
          );
        },
        blockWorkspace: (workspaceId) =>
          scheduleService.cancelWorkspace(workspaceId),
        deleteWorktree: async (workspace) => {
          const managed = workspace.managedWorktree!;
          await gitDeleteManagedWorktree(
            managed.repositoryPath,
            managed.worktreePath,
            managed.branch,
            managed.createdFromHead,
            undefined,
            managed.worktreeGitDir,
            managed.ownershipToken,
            managed.worktreeDevice,
            managed.worktreeInode,
          );
        },
        removeWorkspaceRecord: (workspaceId) =>
          configStore.removeWorkspace(workspaceId),
        finalizeDeletion: async (workspace) => {
          const managed = workspace.managedWorktree!;
          await gitFinalizeManagedWorktreeDeletion(
            managed.worktreePath,
            managed.worktreeGitDir!,
            managed.ownershipToken!,
          );
        },
        finalizeOrphanedDeletions: async (referencedOwnershipTokens) => {
          await gitFinalizeOrphanedManagedWorktreeDeletionJournals(
            await ensureUserDataDir("worktrees"),
            referencedOwnershipTokens,
            (error) => {
              logger.error(
                "git",
                "Could not finalize an orphaned managed worktree deletion journal; it was preserved.",
                error,
              );
            },
          );
        },
        onError: (_workspaceId, error) => {
          logger.error(
            "git",
            "Could not reconcile an interrupted managed worktree deletion; its scheduled work remains blocked.",
            error,
          );
        },
      });
      const settings = await configStore.getSettings();
      try {
        await reconcilePendingProviderCredentialRotation();
      } catch (error) {
        logger.error(
          "providers",
          "Could not reconcile an interrupted provider credential rotation.",
          error,
        );
      }
      try {
        await reconcilePendingMcpCredentialCleanup();
      } catch (error) {
        logger.error(
          "mcp",
          "Could not reconcile an interrupted MCP credential cleanup.",
          error,
        );
      }
      const appearance = normalizeAppearanceConfig(settings.appearance);
      nativeTheme.themeSource = appearance.mode;
      await restoreDockIconPreference(appearance.dockIcon);
      setupApplicationMenu(settings);
      initShortcutBindingsChanged(setupApplicationMenu);

      initShortcut(() => {
        void deliverMainWindowNotification("app:command", {
          commandId: "composer.focus",
        }).catch((error: unknown) => {
          logger.warn(
            "shortcut",
            "Could not focus the composer from the global shortcut",
            error,
          );
        });
      });
      initDictationShortcut(() => {
        toggleDictation();
      });
      initAssistantShortcut(() => {
        void deliverMainWindowNotification("app:command", {
          commandId: "assistant.open",
        }).catch((error: unknown) => {
          logger.warn(
            "assistant",
            "Could not open Aiden from the global shortcut",
            error,
          );
        });
      });
      try {
        await applyShortcutFromSettings();
      } catch (error) {
        logger.warn(
          "shortcut",
          "One or more saved global shortcuts could not be registered.",
          error,
        );
      }
      void foundationModelsConnection.status();
      resolveShortcutInitialization?.();
      resolveShortcutInitialization = null;

      // The active profile's portable config is user-editable, so pick
      // hand-edits up without a restart. Registered after whenReady because
      // powerMonitor is only usable once the app is ready.
      app.on(
        "browser-window-focus",
        () => void portableConfigWatcher.refresh(),
      );
      powerMonitor.on("resume", () => void portableConfigWatcher.refresh());

      await createMainWindow();
      if (packagedSubagentSoak) {
        await runPackagedSubagentSoak(packagedSubagentSoak);
        return;
      }
      await scheduleService.start();
      await telegramService.start();
      appUpdateService.start();
    })
    .catch((error: unknown) => {
      logger.error("main", "Failed to start Aiden Agent", error);
      void shutdownAndQuit();
    });
}
