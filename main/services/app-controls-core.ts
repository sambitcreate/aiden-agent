import { boundedUnicodePrefix } from "../../renderer/shared/unicode-prefix.js";
import { createHash } from "node:crypto";
import { normalizeAppearanceConfig } from "../../renderer/shared/appearance.js";
import {
  parseAppControlOperation,
  resolveAppControlPolicy,
  type AppControlId,
  type AppControlOperation,
  type AppControlPolicy,
  type AppControlReceipt,
  type AppControlSnapshot,
  type AppControlTopic,
  type AppControlValue,
} from "../../renderer/shared/app-controls.js";
import type { AppSettings } from "./types.js";

export interface AppControlContext {
  actor: string;
  workspaceId?: string;
  target: string;
  isCurrent(): boolean;
  /** Supplied by the interactive adapter, never by model parameters. */
  humanGesture: boolean;
  allowedControls?: ReadonlySet<AppControlId>;
  remote?: boolean;
  authorize?(): Promise<void>;
}
export interface AppControlState {
  terminalTheme?: string;
  terminalThemes?: string[];
  settings: AppSettings;
  workspace?: { id: string; name: string; memoryEnabled?: boolean };
}
export interface StoredAppOperation {
  createdAt: number;
  key: string;
  operation: AppControlOperation;
  receipt: AppControlReceipt;
}
export interface AppControlDependencies {
  read(workspaceId?: string): Promise<AppControlState>;
  /** Must check the control revision and owner inside its durable transaction. */
  commit(
    operation: AppControlOperation,
    context: AppControlContext,
  ): Promise<void | { effective: AppControlReceipt["effective"]; warning?: string }>;
  loadOperations(): Promise<StoredAppOperation[]>;
  saveOperations(operations: StoredAppOperation[]): Promise<void>;
  onChanged(): void;
}
export function appControlPolicy(settings: AppSettings): AppControlPolicy {
  return resolveAppControlPolicy(settings);
}
export function appControlValue(state: AppControlState, control: AppControlId): AppControlValue {
  const appearance = normalizeAppearanceConfig(state.settings.appearance);
  switch (control) {
    case "appearance.mode":
      return appearance.mode;
    case "appearance.terminalTheme":
      return state.terminalTheme ?? "dark";
    case "appearance.chatWidth":
      return appearance.chatWidth;
    case "appearance.reduceMotion":
      return appearance.reduceMotion;
    case "memory.enabled":
      return state.settings.memoryEnabled !== false;
    case "memory.workspace":
      return state.workspace?.memoryEnabled !== false;
    case "webSearch.enabled":
      return state.settings.webSearch?.enabled === true;
    case "skills.enabled":
      return state.settings.skillsEnabled !== false;
  }
}
export function appControlRevision(state: AppControlState, control: AppControlId): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        control,
        appControlValue(state, control),
        appControlPolicy(state.settings),
        control === "memory.workspace" ? state.workspace?.id : "host",
      ]),
    )
    .digest("base64url");
}
const GROUPS: Record<
  AppControlTopic,
  { title: string; controls: [AppControlId, string, string][] }
> = {
  appearance: {
    title: "Appearance",
    controls: [
      [
        "appearance.terminalTheme",
        "Terminal theme",
        "Theme for this CLI session and its saved terminal defaults.",
      ],
      ["appearance.mode", "Theme", "Choose the serving app's color mode."],
      ["appearance.chatWidth", "Chat width", "Width of conversations on the serving desktop."],
      ["appearance.reduceMotion", "Reduce motion", "Prefer less motion on the serving desktop."],
    ],
  },
  memory: {
    title: "Memory",
    controls: [
      ["memory.enabled", "Memory", "Use saved memory. Turning this off does not delete facts."],
      [
        "memory.workspace",
        "Workspace memory",
        "Memory for this workspace; the global gate also applies.",
      ],
    ],
  },
  "web-search": {
    title: "Web Search",
    controls: [
      [
        "webSearch.enabled",
        "Web Search",
        "Allow configured web searches. This switch makes no network request.",
      ],
    ],
  },
  skills: {
    title: "Skills",
    controls: [
      ["skills.enabled", "Skills", "Allow skill discovery and use, including built-in skills."],
    ],
  },
};
const OPTIONS: Partial<Record<AppControlId, string[]>> = {
  "appearance.mode": ["system", "light", "dark"],
  "appearance.chatWidth": ["narrow", "default", "wide", "full"],
  "appearance.reduceMotion": ["system", "on", "off"],
};
export class AppControlsService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: AppControlDependencies) {}
  async snapshot(topic: AppControlTopic, context: AppControlContext): Promise<AppControlSnapshot> {
    await context.authorize?.();
    if (!context.isCurrent()) throw new Error("Control target is no longer available.");
    const state = await this.deps.read(context.workspaceId);
    if (!context.isCurrent()) throw new Error("Control target is no longer available.");
    const policy = appControlPolicy(state.settings);
    const group = GROUPS[topic];
    return {
      version: 1,
      title: group.title,
      target: context.target,
      policy,
      rows: group.controls
        .filter(
          ([id]) =>
            (id !== "memory.workspace" || state.workspace) &&
            (id !== "appearance.terminalTheme" || state.terminalTheme !== undefined),
        )
        .map(([id, label, description]) => ({
          id,
          label,
          description,
          scope:
            id === "memory.workspace"
              ? `Workspace — ${boundedUnicodePrefix(state.workspace!.name, 220)}`
              : context.target,
          value: appControlValue(state, id),
          revision: appControlRevision(state, id),
          ...(OPTIONS[id]
            ? {
                options: OPTIONS[id]!.map((value) => ({
                  value,
                  label: value[0].toUpperCase() + value.slice(1),
                })),
              }
            : {}),
          ...(id === "appearance.terminalTheme"
            ? { options: state.terminalThemes?.map((value) => ({ value, label: value })) }
            : {}),
          ...(policy === "disabled" || (context.allowedControls && !context.allowedControls.has(id))
            ? {
                disabledReason:
                  policy === "disabled"
                    ? "App controls are disabled in Settings."
                    : "This device is not allowed to change this control.",
              }
            : {}),
        })),
    };
  }
  async apply(input: unknown, context: AppControlContext): Promise<AppControlReceipt> {
    const operation = parseAppControlOperation(input);
    const run = this.tail.then(async () => {
      await context.authorize?.();
      if (!context.isCurrent()) throw new Error("Control target is no longer available.");
      const state = await this.deps.read(context.workspaceId);
      const policy = appControlPolicy(state.settings);
      if (
        operation.control === "appearance.terminalTheme" &&
        !state.terminalThemes?.includes(String(operation.value))
      )
        throw new Error("This terminal theme is unavailable.");
      if (context.remote && state.settings.remoteAppControlsEnabled !== true)
        throw new Error("Paired-host app controls are disabled in Settings.");
      if (
        policy === "disabled" ||
        (context.allowedControls && !context.allowedControls.has(operation.control))
      )
        throw new Error("This control is not authorized.");
      if (!context.humanGesture && (policy === "ask" || operation.value === true || operation.control === "memory.workspace"))
        throw new Error("Show this control for an explicit foreground confirmation.");
      if (operation.control === "memory.workspace" && !state.workspace)
        throw new Error("Select an existing workspace first.");
      const key = `${context.actor}:${context.workspaceId ?? "host"}:${operation.operationId}`;
      const operations = (await this.deps.loadOperations()).filter(
        (item) =>
          item.receipt.status === "outcome_unknown" ||
          item.createdAt > Date.now() - 30 * 24 * 60 * 60 * 1000,
      );
      const existing = operations.find((item) => item.key === key);
      if (existing) {
        if (JSON.stringify(existing.operation) !== JSON.stringify(operation))
          throw new Error("Operation ID was already used for another change.");
        return existing.receipt;
      }
      if (operation.expectedRevision !== appControlRevision(state, operation.control))
        throw new Error("Settings changed. Refresh this control before trying again.");
      if (!context.isCurrent()) throw new Error("Control target is no longer available.");
      if (operations.length >= 500)
        throw new Error(
          "Control operation history is full. Completed operations expire after 30 days.",
        );
      const receipt: AppControlReceipt = {
        status: "outcome_unknown",
        operationId: operation.operationId,
        control: operation.control,
        value: operation.value,
        scope:
          operation.control === "memory.workspace"
            ? `Workspace — ${boundedUnicodePrefix(state.workspace!.name, 220)}`
            : context.target,
        effective: operation.control.startsWith("appearance.") ? "now" : "next_turn",
      };
      const stored = { key, operation, receipt, createdAt: Date.now() };
      operations.push(stored);
      // Persist intent before entering any effect. A crash or uncertain commit never retries automatically.
      await this.deps.saveOperations(operations);
      if (!context.isCurrent()) return receipt;
      if (appControlValue(state, operation.control) === operation.value)
        receipt.status = "already_set";
      else {
        await context.authorize?.();
        if (!context.isCurrent()) return receipt;
        const application = await this.deps.commit(operation, context);
        if (application) {
          receipt.effective = application.effective;
          receipt.warning = application.warning;
        }
        const observed = await this.deps.read(context.workspaceId);
        if (appControlValue(observed, operation.control) !== operation.value)
          throw new Error("Preference could not be verified. Refresh its current value.");
        receipt.status = "applied";
      }
      await this.deps.saveOperations(operations);
      this.deps.onChanged();
      return receipt;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
