import { join } from "node:path";
import {
  AppControlsService,
  appControlRevision,
  type AppControlState,
  type StoredAppOperation,
} from "../../../main/services/app-controls-core.js";
import {
  normalizeWebSearchSettings,
  defaultWebSearchSettings,
} from "../../../main/services/web-search-provider-registry-core.js";
import type { AppControlId, AppControlTopic } from "../../../renderer/shared/app-controls.js";
import { JsonStore, acquireLease } from "./state.ts";
import { readAidenSettings } from "./extensions/aiden-settings.ts";

export const CLI_APP_CONTROLS: ReadonlySet<AppControlId> = new Set([
  "appearance.terminalTheme",
  "memory.enabled",
  "webSearch.enabled",
]);
export interface CliControlUi {
  currentTheme(): string;
  themes(): string[];
  setTheme(name: string): { success: boolean; error?: string };
}
export function createCliAppControls(agentDir: string, ui: () => CliControlUi | undefined) {
  const settingsStore = new JsonStore<Record<string, unknown>>(join(agentDir, "aiden.json"), {});
  const webStore = new JsonStore<Record<string, unknown>>(
    join(agentDir, "web-search.json"),
    defaultWebSearchSettings() as unknown as Record<string, unknown>,
  );
  const terminalStore = new JsonStore<Record<string, unknown>>(join(agentDir, "settings.json"), {});
  const ledger = new JsonStore<StoredAppOperation[]>(
    join(agentDir, "app-control-operations.json"),
    [],
  );
  const read = async (): Promise<AppControlState> => ({
    settings: {
      ...readAidenSettings(agentDir),
      webSearch: normalizeWebSearchSettings(await webStore.load()),
    },
    terminalTheme: ui()?.currentTheme() ?? String((await terminalStore.load()).theme ?? "dark"),
    terminalThemes: ui()?.themes() ?? [],
  });
  const service = new AppControlsService({
    read,
    loadOperations: () => ledger.load(),
    saveOperations: async (value) => {
      await ledger.save(value);
    },
    onChanged() {},
    commit: async (operation, context) => {
      if (!CLI_APP_CONTROLS.has(operation.control))
        throw new Error("This is a desktop-only control.");
      const assertRevision = async () => {
        if (
          !context.isCurrent() ||
          appControlRevision(await read(), operation.control) !== operation.expectedRevision
        )
          throw new Error("Settings changed. Refresh this control.");
      };
      if (operation.control === "appearance.terminalTheme") {
        const native = ui();
        if (!native || !native.themes().includes(String(operation.value)))
          throw new Error("Terminal theme changes require the interactive TUI.");
        await assertRevision();
        const result = native.setTheme(String(operation.value));
        if (!result.success) throw new Error(result.error ?? "Theme is unavailable.");
        // Pi owns its SettingsManager and write queue. Do not race it with a
        // second writer. A visible theme alone is not a persistence receipt.
        let persisted = false;
        for (let attempt = 0; attempt < 100 && context.isCurrent(); attempt++) {
          if ((await terminalStore.load()).theme === operation.value) {
            persisted = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (!persisted)
          throw new Error(
            "The terminal changed, but its saved default could not be confirmed. Refresh before another change.",
          );
        return { effective: "now" };
      }
      if (operation.control === "webSearch.enabled")
        await webStore.update(async (draft) => {
          await assertRevision();
          Object.assign(draft, normalizeWebSearchSettings({ ...draft, enabled: operation.value }));
        }, context.isCurrent);
      else
        await settingsStore.update(async (draft) => {
          await assertRevision();
          draft.memoryEnabled = operation.value;
        }, context.isCurrent);
      return {
        effective: "next_session",
        warning:
          "Saved. Start a new CLI process to rebuild its feature tools. Disabling is also checked by existing tools before further work.",
      };
    },
  });
  return {
    snapshot: async (
      topic: AppControlTopic,
      interactive: boolean,
      isCurrent: () => boolean = () => true,
    ) => {
      const snapshot = await service.snapshot(topic, {
        actor: "cli",
        target: "This CLI",
        isCurrent,
        humanGesture: false,
        allowedControls: interactive ? CLI_APP_CONTROLS : new Set(),
      });
      if (topic === "appearance")
        snapshot.rows = snapshot.rows.filter((row) => row.id === "appearance.terminalTheme");
      for (const row of snapshot.rows)
        if (!CLI_APP_CONTROLS.has(row.id))
          row.disabledReason =
            "This setting has no supported CLI execution gate. Use the native CLI setup options.";
      return snapshot;
    },
    async apply(
      input: unknown,
      interactive: boolean,
      humanGesture: boolean,
      explicitAdministration = false,
      isCurrent: () => boolean = () => true,
    ) {
      if (!interactive && !explicitAdministration)
        throw new Error(
          "Agent app mutations require the interactive CLI. Use an explicit human app command for headless administration.",
        );
      const release = acquireLease(join(agentDir, "app-controls-owner"));
      try {
        return await service.apply(input, {
          actor: "cli",
          target: "This CLI",
          isCurrent,
          humanGesture,
          allowedControls: CLI_APP_CONTROLS,
        });
      } finally {
        release();
      }
    },
  };
}
