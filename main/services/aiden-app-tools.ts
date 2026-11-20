import { AIDEN_APP_DESTINATIONS } from "./aiden-app-navigation.js";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";
import { readAidenHelp } from "./aiden-app-knowledge.js";
import type { AppControlsService, AppControlContext } from "./app-controls-core.js";
import {
  APP_CONTROL_TOPICS,
  REMOTE_APP_CONTROL_TOPICS,
  parseAppControlOperation,
  isAppControlTopic,
  type AppControlPanel,
  type AppControlTopic,
} from "../../renderer/shared/app-controls.js";

/** The app-control tools a chat always declares, in this order. */
export const AIDEN_APP_TOOL_NAMES = [
  "aiden_help",
  "aiden_get_state",
  "aiden_show_controls",
  "aiden_open",
  "aiden_set_preference",
] as const;

/**
 * Why `name` cannot run in this turn, or undefined when it can. Every app tool
 * is declared in every turn so the tool list stays the same whether the chat
 * is answered on this computer or from a paired device; what a paired device
 * cannot reach is refused here, before the call runs.
 */
export function aidenAppToolUnavailableReason(
  name: string,
  args: unknown,
  turn: { liveState: boolean; canOpen: boolean },
): string | undefined {
  if (!(AIDEN_APP_TOOL_NAMES as readonly string[]).includes(name)) return undefined;
  const remoteTopics = [...REMOTE_APP_CONTROL_TOPICS].join(", ");
  if (!turn.liveState) {
    if (name === "aiden_get_state" || name === "aiden_set_preference" || name === "aiden_open") {
      return `${name} is not available in this turn: the request came from a paired device. Open the chat on this computer to read or change settings, or show one of these panels: ${remoteTopics}.`;
    }
    if (name === "aiden_show_controls") {
      const topic = (args as Record<string, unknown> | undefined)?.topic;
      if (typeof topic !== "string" || !REMOTE_APP_CONTROL_TOPICS.has(topic as AppControlTopic)) {
        return `This settings panel is not available in this turn: the request came from a paired device, which shows only these panels: ${remoteTopics}.`;
      }
    }
  }
  if (name === "aiden_open" && !turn.canOpen) {
    return "aiden_open is not available in this turn: no Aiden window asked, so there is no Settings page to open.";
  }
  return undefined;
}

export function createAidenAppTools(options: {
  service: AppControlsService;
  context: AppControlContext;
  liveState?: boolean;
  runtime?: Record<string, unknown>;
  open?(destination: unknown, signal?: AbortSignal): Promise<unknown>;
  present(panel: AppControlPanel): void;
}): AgentTool[] {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: null,
  });
  const turn = { liveState: options.liveState !== false, canOpen: options.open !== undefined };
  /** The host refuses these calls before they run; this keeps the tool closed on its own. */
  const refuseUnavailable = (name: string, args: unknown) => {
    const reason = aidenAppToolUnavailableReason(name, args, turn);
    if (reason) throw new Error(reason);
  };
  return [
    declarePiRuntimeReplay(
      {
        name: "aiden_help",
        label: "Aiden help",
        description:
          "Read bounded offline installed product documentation. Use for questions about Aiden, its agent, features, privacy or settings.",
        parameters: Type.Object({ query: Type.String({ maxLength: 256 }) }),
        execute: async (_id, p) => result(readAidenHelp((p as Record<string, unknown>).query)),
      },
      "safe",
    ),
    declarePiRuntimeReplay(
      {
        name: "aiden_get_state",
        label: "Aiden settings",
        description:
          "Read real current preferences and their exact target/scope, availability and app control policy.",
        parameters: Type.Object({
          topic: Type.Union(APP_CONTROL_TOPICS.map((topic) => Type.Literal(topic))),
        }),
        execute: async (_id, p) => {
          refuseUnavailable("aiden_get_state", p);
          if (!isAppControlTopic((p as Record<string, unknown>).topic))
            throw new Error("Unknown settings topic.");
          return result({
            ...(await options.service.snapshot(
              (p as Record<string, unknown>)
                .topic as import("../../renderer/shared/app-controls.js").AppControlTopic,
              options.context,
            )),
            runtime: options.runtime,
          });
        },
      },
      "safe",
    ),
    declarePiRuntimeReplay(
      {
        name: "aiden_show_controls",
        label: "Show Aiden controls",
        description:
          "Show real interactive settings in chat. Use when users ask to see settings or how to configure a feature. Displaying a panel changes nothing.",
        parameters: Type.Object({
          // Every topic in every turn; a phone chat's call for a card phones
          // do not understand is refused before it runs.
          topic: Type.Union(APP_CONTROL_TOPICS.map((topic) => Type.Literal(topic))),
        }),
        execute: async (_id, p, signal) => {
          refuseUnavailable("aiden_show_controls", p);
          if (
            !isAppControlTopic((p as Record<string, unknown>).topic) ||
            (options.liveState === false &&
              !REMOTE_APP_CONTROL_TOPICS.has((p as Record<string, unknown>).topic as AppControlTopic)) ||
            signal?.aborted ||
            !options.context.isCurrent()
          )
            throw new Error("Settings panel is unavailable.");
          const snapshot =
            options.liveState === false
              ? { title: "Aiden settings", target: options.context.target }
              : await options.service.snapshot(
                  (p as Record<string, unknown>)
                    .topic as import("../../renderer/shared/app-controls.js").AppControlTopic,
                  options.context,
                );
          const panel: AppControlPanel = {
            version: 1,
            id: randomUUID(),
            topic: (p as Record<string, unknown>)
              .topic as import("../../renderer/shared/app-controls.js").AppControlTopic,
            ...(options.context.workspaceId ? { workspaceId: options.context.workspaceId } : {}),
            fallback: `${snapshot.title} — ${snapshot.target}. Ask Aiden about these settings or use the app's Settings page.`,
          };
          options.present(panel);
          return result({ panelShown: true, ...snapshot });
        },
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "aiden_open",
        label: "Open Aiden settings",
        description:
          "Open a supported Settings section in the Aiden Agent window that asked. Report opened only after the renderer confirms navigation. This grants no feature or OS permission.",
        parameters: Type.Object({
          destination: Type.Union(AIDEN_APP_DESTINATIONS.map((value) => Type.Literal(value))),
        }),
        execute: async (_id, p, signal) => {
          refuseUnavailable("aiden_open", p);
          return result(await options.open!((p as Record<string, unknown>).destination, signal));
        },
      },
      "never",
    ),
    declarePiRuntimeReplay(
      {
        name: "aiden_set_preference",
        label: "Change Aiden preference",
        description:
          "Set one exact preference after an explicit user request and a fresh aiden_get_state read. Workspace Memory, enablement or Ask policy needs a foreground control click. Do not toggle by guessing or widen workspace/host scope.",
        parameters: Type.Object({
          control: Type.String(),
          value: Type.Union([Type.String(), Type.Boolean()]),
          expectedRevision: Type.String(),
          operationId: Type.String(),
        }),
        execute: async (_id, p, signal) => {
          refuseUnavailable("aiden_set_preference", p);
          if (signal?.aborted) throw new Error("Change cancelled.");
          const operation = parseAppControlOperation(p);
          // Workspace mutations settle every generation. The generation awaiting
          // this tool cannot settle itself; redirect before any durable intent.
          if (operation.control === "memory.workspace") {
            if (!options.context.workspaceId) throw new Error("Select an existing workspace first.");
            await options.service.snapshot("memory", options.context);
            if (signal?.aborted || !options.context.isCurrent()) throw new Error("Change cancelled.");
            options.present({ version: 1, id: randomUUID(), topic: "memory", workspaceId: options.context.workspaceId,
              fallback: "Use Workspace memory controls to confirm this change on your computer." });
            return result({ status: "foreground_required", panelShown: true,
              reason: "Change Workspace memory through the foreground control so the active agent can settle before saving." });
          }
          return result(
            await options.service.apply(p, {
              ...options.context,
              isCurrent: () => !signal?.aborted && options.context.isCurrent(),
              humanGesture: false,
            }),
          );
        },
      },
      "never",
    ),
  ];
}
