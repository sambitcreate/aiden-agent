import { AppControlsService, appControlRevision, newChatModelChoices } from "./app-controls-core.js";
import { listConfiguredProviders } from "./provider-list-main.js";
import { ipcMain } from "../platform.js";
import type { StoredAppOperation } from "./app-controls-core.js";
import { configStore } from "./config-store.js";
import { DataStore } from "./data-store.js";
import { publishAppControlsChanged } from "./app-controls-events-main.js";
import { applySettingsEffects, appearancePreview } from "./settings-application-effects.js";
import { normalizeAppearanceConfig } from "../../renderer/shared/appearance.js";
import { assertWebSearchRolloutMutationAllowed, webSearchRollout } from "./web-search-rollout.js";
import { parseAppControlOperation } from "../../renderer/shared/app-controls.js";

function validLedger(value: unknown): value is StoredAppOperation[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  try {
    const keys = new Set<string>();
    for (const item of value) {
      parseAppControlOperation(item.operation);
      if (
        typeof item.key !== "string" ||
        item.key.length > 400 ||
        keys.has(item.key) ||
        !["applied", "already_set", "outcome_unknown"].includes(item.receipt?.status) ||
        item.receipt?.operationId !== item.operation.operationId ||
        item.receipt?.control !== item.operation.control ||
        item.receipt?.value !== item.operation.value ||
        !Number.isSafeInteger(item.createdAt)
      )
        return false;
      keys.add(item.key);
    }
    return true;
  } catch {
    return false;
  }
}
const operations = new DataStore<StoredAppOperation[]>(
  "app-control-operations.json",
  [],
  undefined,
  {
    maxBytes: 1024 * 1024,
    fileMode: 0o600,
    preserveCorruptFile: true,
    reloadBeforeWrite: true,
    rejectCorruptWrite: true,
    rejectUnsafeWrite: true,
    rejectExternalChanges: true,
    normalize: (value) => (validLedger(value) ? value : []),
    isSafe: validLedger,
  },
);
export const appControlsService = new AppControlsService({
  read: async (workspaceId) => {
    const settings = await configStore.getSettings();
    return {
      settings,
      workspace: workspaceId ? await configStore.getWorkspace(workspaceId) : undefined,
      newChatModels: newChatModelChoices(await listConfiguredProviders(), settings),
    };
  },
  loadOperations: () => operations.load(),
  saveOperations: async (value) => {
    await operations.save(value);
  },
  onChanged: publishAppControlsChanged,
  commit: async (operation, context) => {
    if (operation.control === "webSearch.enabled")
      assertWebSearchRolloutMutationAllowed("set-enabled", undefined, webSearchRollout);
    if (operation.control === "memory.workspace") {
      const settings = await configStore.getSettings();
      const { workspaceApplicationService } =
        await import("./workspace-application-service-main.js");
      await workspaceApplicationService.update(
        context.workspaceId!,
        { memoryEnabled: operation.value },
        {
          beforeSave: async (workspace) => {
            await context.authorize?.();
            const currentSettings = await configStore.getSettings();
            if (
              !workspace ||
              !context.isCurrent() ||
              (context.remote && currentSettings.remoteAppControlsEnabled !== true) ||
              currentSettings.appControlPolicy === "disabled" ||
              appControlRevision({ settings: currentSettings, workspace }, operation.control) !==
                operation.expectedRevision
            )
              throw new Error("Workspace control authority changed. Refresh this control.");
          },
          assertCurrent: (workspace) => {
            if (
              !context.isCurrent() ||
              appControlRevision({ settings, workspace }, operation.control) !==
                operation.expectedRevision
            )
              throw new Error("Workspace settings changed. Refresh this control.");
          },
        },
      );
    } else {
      const saved = await configStore.updateAppControl(
        operation,
        context.isCurrent,
        context.remote,
        context.authorize,
      );
      if (operation.control === "models.newChat") {
        // The desktop keeps its new-chat model in each window; tell them.
        ipcMain.broadcast("settings:new-chat-model-changed", {
          providerId: saved.lastProviderId,
          model: saved.lastModel,
        });
        return;
      }
      const patch = operation.control.startsWith("appearance.")
        ? { appearance: saved.appearance }
        : operation.control === "skills.enabled"
          ? { skillsEnabled: saved.skillsEnabled }
          : operation.control === "memory.enabled"
            ? { memoryEnabled: saved.memoryEnabled }
            : { webSearch: saved.webSearch };
      await applySettingsEffects(saved, patch);
      if (
        patch.appearance &&
        appearancePreview.snapshot(normalizeAppearanceConfig(saved.appearance)).pending
      ) {
        return {
          effective: "after_preview",
          warning:
            "Saved. An Appearance preview is still active; this preference applies when that preview ends.",
        };
      }
    }
  },
});
