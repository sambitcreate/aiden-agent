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

/** Settings `aiden app set` can change; everything else is read-only here. */
export const CLI_APP_CONTROLS: ReadonlySet<AppControlId> = new Set([
  "memory.enabled",
  "webSearch.enabled",
]);
/** The topics `aiden app status` and `aiden app get` show. Appearance is desktop-only. */
export const CLI_APP_TOPICS = ["memory", "web-search", "skills"] as const satisfies readonly AppControlTopic[];
export type CliAppTopic = (typeof CLI_APP_TOPICS)[number];
export function isCliAppTopic(value: unknown): value is CliAppTopic {
  return CLI_APP_TOPICS.includes(value as CliAppTopic);
}
/** App controls for explicit human administration (`aiden app`); no agent can reach them. */
export function createCliAppControls(agentDir: string) {
  const settingsStore = new JsonStore<Record<string, unknown>>(join(agentDir, "aiden.json"), {});
  const webStore = new JsonStore<Record<string, unknown>>(
    join(agentDir, "web-search.json"),
    defaultWebSearchSettings() as unknown as Record<string, unknown>,
  );
  const ledger = new JsonStore<StoredAppOperation[]>(
    join(agentDir, "app-control-operations.json"),
    [],
  );
  const read = async (): Promise<AppControlState> => ({
    settings: {
      ...readAidenSettings(agentDir),
      webSearch: normalizeWebSearchSettings(await webStore.load()),
    },
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
          "Saved. New sessions use the change. Disabling is also checked by existing tools before further work.",
      };
    },
  });
  return {
    snapshot: async (topic: CliAppTopic, isCurrent: () => boolean = () => true) => {
      const snapshot = await service.snapshot(topic, {
        actor: "cli",
        target: "This CLI",
        isCurrent,
        humanGesture: false,
        allowedControls: CLI_APP_CONTROLS,
      });
      for (const row of snapshot.rows)
        if (!CLI_APP_CONTROLS.has(row.id))
          row.disabledReason =
            "This setting has no supported CLI execution gate. Change it in the Aiden desktop app.";
      return snapshot;
    },
    async apply(input: unknown, isCurrent: () => boolean = () => true) {
      const release = acquireLease(join(agentDir, "app-controls-owner"));
      try {
        return await service.apply(input, {
          actor: "cli",
          target: "This CLI",
          isCurrent,
          humanGesture: true,
          allowedControls: CLI_APP_CONTROLS,
        });
      } finally {
        release();
      }
    },
  };
}
