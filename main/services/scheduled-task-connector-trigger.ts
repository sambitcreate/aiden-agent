// Chat tasks that run when a connected app has news (docs/scheduled-task-triggers.md):
// a local Mail mailbox through iMCP on a Mac, or a Composio calendar.
//
// Authority comes from two places only. **Find sources** is a foreground step
// the person takes in the task editor: it lists sources through connections
// that are already open and hands back opaque choices. Saving the task swaps
// the chosen one for its exact binding (the connector's connection, tools and
// account, plus a fingerprint of the connector's configuration), which stays
// in main. A background check then reads through an open connection only, and
// refuses when the connector or its access no longer matches that binding. It
// never connects, signs in or reconnects anything.

import { randomUUID } from "node:crypto";
import {
  BOT_CONNECTOR_WATCH_LIMITS,
  type BotConnectorWatchCondition,
  type BotConnectorWatchSourceChoice,
  type BotConnectorWatchSourceList,
} from "../../renderer/shared/bot-connector-watches.js";
import { mcpServerOffersTools } from "../../renderer/shared/mcp-exposure.js";
import type {
  ScheduledTaskConnectorTrigger,
  ScheduledTaskTrigger,
} from "../../renderer/shared/scheduled-task-trigger.js";
import {
  boundedConnectorText,
  connectorSourceLabels,
} from "./bot-routine-events/connector-text.js";
import { BotConnectorWatchError } from "./bot-routine-events/connector-service.js";
import {
  connectorBindingMatchesCondition,
  type BotConnectorWatchBaseline,
  type BotConnectorWatchBinding,
} from "./bot-routine-events/connector-types.js";
import type { BotWatchCheck } from "./bot-routine-events/watch-sources.js";
import { scheduledMcpServerBinding } from "./schedule-mcp-binding.js";
import type { McpServer } from "./types.js";

/** A task's exact source: the binding Find sources made, and the connector's configuration then. */
export interface TaskConnectorSource {
  binding: BotConnectorWatchBinding;
  /** `scheduledMcpServerBinding(server).fingerprint` when the source was found. */
  serverFingerprint: string;
}

export interface TaskConnectorRead {
  items: ReadonlyArray<{ title: string }>;
  baseline: BotConnectorWatchBaseline;
  changes: ReadonlyArray<{ kind: string; item: { title: string } }>;
}

export interface TaskConnectorPorts {
  /** Foreground Find sources: every source the open connections offer, and why others aren't offered. */
  discover(
    signal: AbortSignal,
  ): Promise<{ bindings: BotConnectorWatchBinding[]; unavailableReasons: string[] }>;
  /** A background read through a connection that is already open; never connects or signs in. */
  read(
    taskId: string,
    binding: BotConnectorWatchBinding,
    condition: BotConnectorWatchCondition,
    baseline: BotConnectorWatchBaseline | undefined,
    signal: AbortSignal,
  ): Promise<TaskConnectorRead>;
  /** The connector as configured now. */
  server(serverId: string): Promise<McpServer | undefined>;
  now(): number;
}

/** How long a Find sources choice can be saved. */
const CHOICE_LIFETIME_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000;

export class TaskConnectorChoiceError extends Error {}

export { TASK_CONNECTOR_NEEDS_SOURCE } from "../../renderer/shared/scheduled-task-trigger.js";

const templateOf = (binding: BotConnectorWatchBinding) =>
  binding.adapter === "imcp-mail-v1" ? ("mail_messages" as const) : ("calendar_upcoming" as const);

/**
 * Whether the task may still read its source: a connector that was removed,
 * turned off or hidden from the model is revoked (the task pauses); one whose
 * configuration changed since Find sources has drifted (the check refuses).
 */
export function taskConnectorAuthority(
  source: TaskConnectorSource,
  server: McpServer | undefined,
): { ok: true } | { ok: false; pause: boolean; error: string } {
  if (!server || !server.enabled || !mcpServerOffersTools(server)) {
    return {
      ok: false,
      pause: true,
      error:
        "This task's connected app was removed or turned off. Turn it back on in Settings → Connectors, then find its source again.",
    };
  }
  if (scheduledMcpServerBinding(server).fingerprint !== source.serverFingerprint) {
    return {
      ok: false,
      pause: false,
      error:
        "This connected app's setup changed since its source was chosen. Find its source again in the task.",
    };
  }
  return { ok: true };
}

export function createTaskConnectorTriggers(ports: TaskConnectorPorts) {
  const choices = new Map<
    string,
    { at: number; source: TaskConnectorSource; labels: ReturnType<typeof connectorSourceLabels> }
  >();

  function prune(): void {
    const now = ports.now();
    for (const [id, choice] of choices)
      if (now - choice.at > CHOICE_LIFETIME_MS) choices.delete(id);
  }

  return {
    /** The foreground Find sources step. Choices stay valid for 15 minutes. */
    async findSources(signal: AbortSignal): Promise<BotConnectorWatchSourceList> {
      const found = await ports.discover(signal);
      signal.throwIfAborted();
      prune();
      const result: BotConnectorWatchSourceChoice[] = [];
      for (const binding of found.bindings.slice(0, BOT_CONNECTOR_WATCH_LIMITS.sources)) {
        const server = await ports.server(binding.serverId);
        if (!server) continue;
        const labels = connectorSourceLabels(binding.labels);
        const id = randomUUID();
        choices.set(id, {
          at: ports.now(),
          labels,
          source: {
            binding: { ...structuredClone(binding), labels },
            serverFingerprint: scheduledMcpServerBinding(server).fingerprint,
          },
        });
        result.push({ id, templateId: templateOf(binding), ...labels, available: true });
      }
      return {
        choices: result,
        unavailableReasons: found.unavailableReasons
          .map((reason) => boundedConnectorText(reason, BOT_CONNECTOR_WATCH_LIMITS.errorChars))
          .slice(0, 16),
      };
    },

    /**
     * The exact source behind a choice, for a save. The trigger's labels are
     * replaced by the source's own; a choice of the wrong kind is refused.
     */
    takeChoice(trigger: ScheduledTaskConnectorTrigger): {
      trigger: ScheduledTaskConnectorTrigger;
      source: TaskConnectorSource;
    } {
      prune();
      const choice = trigger.sourceChoiceId ? choices.get(trigger.sourceChoiceId) : undefined;
      if (!choice)
        throw new TaskConnectorChoiceError("The source choice expired. Choose Find sources again.");
      if (!connectorBindingMatchesCondition(choice.source.binding, trigger.condition)) {
        throw new TaskConnectorChoiceError(
          trigger.condition.kind === "email"
            ? "Choose a Mail mailbox for this task."
            : "Choose a calendar for this task.",
        );
      }
      const { sourceChoiceId: _used, ...rest } = trigger;
      return {
        trigger: { ...rest, source: { ...choice.labels } },
        source: structuredClone(choice.source),
      };
    },

    /** A choice a save used: it can't be saved again, for this task or another. */
    forgetChoice(id: string): void {
      choices.delete(id.toLowerCase());
    },

    /** One background check. The first check of a source only records a baseline. */
    async check(
      task: { id: string; trigger: ScheduledTaskConnectorTrigger },
      source: TaskConnectorSource | undefined,
      baseline: BotConnectorWatchBaseline | undefined,
      signal: AbortSignal,
    ): Promise<BotWatchCheck> {
      if (!source)
        return {
          ok: false,
          pause: true,
          error: "This task has no source. Find its source again in the task.",
        };
      if (!connectorBindingMatchesCondition(source.binding, task.trigger.condition)) {
        return {
          ok: false,
          pause: true,
          error:
            "This task's source doesn't match what it watches. Find its source again in the task.",
        };
      }
      const authority = taskConnectorAuthority(source, await ports.server(source.binding.serverId));
      if (!authority.ok) return { ok: false, pause: authority.pause, error: authority.error };
      try {
        const result = await ports.read(
          task.id,
          source.binding,
          task.trigger.condition,
          baseline,
          AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
        );
        return {
          ok: true,
          bytes: new TextEncoder().encode(JSON.stringify(result.baseline)),
          connector: {
            baseline: result.baseline,
            itemCount: result.items.length,
            changeCount: result.changes.length,
            payload: boundedConnectorText(
              result.changes
                .slice(0, 8)
                .map((change) => `${change.kind}: ${change.item.title}`)
                .join("\n"),
              3_900,
            ),
          },
        };
      } catch (error) {
        if (signal.aborted) return { ok: false, skipped: true, error: "The check stopped." };
        // Only the connector layer's own messages are shown; anything else may carry raw provider text.
        const message =
          error instanceof BotConnectorWatchError
            ? error.message
            : "The connected app couldn't be read. Check it in Settings → Connectors.";
        return {
          ok: false,
          error: boundedConnectorText(message, BOT_CONNECTOR_WATCH_LIMITS.errorChars),
        };
      }
    },
  };
}

export type TaskConnectorTriggers = ReturnType<typeof createTaskConnectorTriggers>;

/**
 * What a save of a connected-app task keeps: a fresh Find sources choice is
 * swapped for its exact source (bound after the save); an edit without one
 * keeps the task's current source, as long as it still watches the same kind.
 */
export function connectorTriggerForSave(
  trigger: ScheduledTaskConnectorTrigger,
  existing: ScheduledTaskTrigger | undefined,
  takeChoice: TaskConnectorTriggers["takeChoice"],
): { trigger: ScheduledTaskConnectorTrigger; source?: TaskConnectorSource } {
  if (trigger.sourceChoiceId) return takeChoice(trigger);
  if (existing?.kind !== "connector" || existing.condition.kind !== trigger.condition.kind) {
    throw new TaskConnectorChoiceError("Choose this task's source with Find sources.");
  }
  return { trigger: { ...trigger, source: { ...existing.source } } };
}

/**
 * Saves a connected-app task. A Find sources choice becomes the task's exact
 * source and is used up once the save lands; the source is bound after it.
 * The two steps can't share one store write (the binding stays out of the
 * task file), so a bind that fails marks the task as needing its source
 * rather than leaving it on and silently never checking.
 */
export async function saveConnectorTask<T extends { id: string }>(
  trigger: ScheduledTaskConnectorTrigger,
  existing: ScheduledTaskTrigger | undefined,
  steps: {
    connector: Pick<TaskConnectorTriggers, "takeChoice" | "forgetChoice">;
    save(trigger: ScheduledTaskConnectorTrigger): Promise<T>;
    bind(taskId: string, source: TaskConnectorSource): Promise<void>;
    needsSource(taskId: string): Promise<void>;
  },
): Promise<T> {
  const { trigger: next, source } = connectorTriggerForSave(
    trigger,
    existing,
    steps.connector.takeChoice,
  );
  const saved = await steps.save(next);
  if (trigger.sourceChoiceId) steps.connector.forgetChoice(trigger.sourceChoiceId);
  if (!source) return saved;
  try {
    await steps.bind(saved.id, source);
  } catch (error) {
    await steps.needsSource(saved.id).catch(() => undefined);
    throw Object.assign(
      new Error(
        "The task was saved, but its source couldn't be connected. Open it, choose Find sources and save it again.",
      ),
      { cause: error },
    );
  }
  return saved;
}
