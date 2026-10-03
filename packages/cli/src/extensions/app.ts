import { Type } from "@earendil-works/pi-ai";
import type {
  InlineExtension,
  ExtensionContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  readAidenHelp,
  AIDEN_APP_GUIDANCE,
  AIDEN_APP_SKILL,
} from "../../../../main/services/aiden-app-knowledge.js";
import {
  APP_CONTROL_TOPICS,
  isAppControlTopic,
  type AppControlTopic,
  type AppControlPanel,
} from "../../../../renderer/shared/app-controls.js";
import { createCliAppControls } from "../app-controls.ts";
import { readAidenSettings } from "./aiden-settings.ts";

const OWNED_NAMES = new Set([
  "aiden_help",
  "aiden_get_state",
  "aiden_show_controls",
  "aiden_set_preference",
  "skill_aiden_app",
  "aiden_open",
]);
/** Exact host-owned source, not a tool-name prefix exemption. */
export function isOwnedAppTool(pi: Pick<ExtensionAPI, "getAllTools">, name: string): boolean {
  return (
    OWNED_NAMES.has(name) &&
    typeof pi.getAllTools === "function" &&
    pi
      .getAllTools()
      .some((tool) => tool.name === name && tool.sourceInfo.path === "<inline:aiden-app>")
  );
}
export function createAppExtension(agentDir: string): InlineExtension {
  return {
    name: "aiden-app",
    factory(pi) {
      let current: ExtensionContext | undefined;
      let sessionEpoch = 0;
      const owner = (ctx: ExtensionContext, signal?: AbortSignal) => {
        const id = ctx.sessionManager.getSessionId(),
          epoch = sessionEpoch;
        return () =>
          !signal?.aborted &&
          epoch === sessionEpoch &&
          current?.sessionManager.getSessionId() === id;
      };
      const controls = createCliAppControls(agentDir, () =>
        current?.hasUI
          ? {
              currentTheme: () => current!.ui.theme.name ?? "dark",
              themes: () => current!.ui.getAllThemes().map((theme) => theme.name),
              setTheme: (name) => current!.ui.setTheme(name),
            }
          : undefined,
      );
      pi.on("session_start", (_event, ctx) => {
        current = ctx;
        sessionEpoch++;
      });
      pi.on("before_agent_start", (event, ctx) => {
        current = ctx;
        return { systemPrompt: `${event.systemPrompt}\n\n${AIDEN_APP_GUIDANCE}` };
      });
      const text = (value: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        details: {},
      });
      const topicSchema = Type.Object({
        topic: Type.Union(APP_CONTROL_TOPICS.map((topic) => Type.Literal(topic))),
      });
      pi.registerTool({
        name: "aiden_help",
        label: "Aiden help",
        description: "Read installed Aiden product help offline.",
        parameters: Type.Object({ query: Type.String({ maxLength: 256 }) }),
        execute: async (_id, params) => text(readAidenHelp(params.query)),
      });
      pi.registerTool({
        name: "aiden_get_state",
        label: "Aiden settings",
        description: "Read current supported CLI controls and scope.",
        parameters: topicSchema,
        execute: async (_id, params, _signal, _update, ctx) => {
          current = ctx;
          return text(await controls.snapshot(params.topic, ctx.hasUI, owner(ctx, _signal)));
        },
      });
      pi.registerTool({
        name: "aiden_show_controls",
        label: "Show Aiden controls",
        description: "Show real CLI settings in the conversation; no change from rendering.",
        parameters: topicSchema,
        execute: async (_id, params, _signal, _update, ctx) => {
          current = ctx;
          const snapshot = await controls.snapshot(params.topic, ctx.hasUI, owner(ctx, _signal));
          const panel: AppControlPanel = {
            version: 1,
            id: randomUUID(),
            topic: params.topic,
            fallback: `Use /aiden-settings ${params.topic} to change supported settings.`,
          };
          pi.sendMessage({
            customType: "aiden-controls",
            content: panel.fallback,
            display: true,
            details: panel,
          });
          if (ctx.hasUI)
            ctx.ui.setWidget("aiden-controls", [
              snapshot.title + " — This CLI",
              ...snapshot.rows.map(
                (row) =>
                  `${row.label}: ${String(row.value)}${row.disabledReason ? " (unavailable)" : ""}`,
              ),
              panel.fallback,
            ]);
          return text(snapshot);
        },
      });
      pi.registerTool({
        name: "aiden_set_preference",
        label: "Change Aiden preference",
        description:
          "Apply an explicit supported CLI preference with a fresh revision. Enablement needs /aiden-settings confirmation.",
        parameters: Type.Object({
          control: Type.String(),
          value: Type.Union([Type.String(), Type.Boolean()]),
          expectedRevision: Type.String(),
          operationId: Type.String(),
        }),
        execute: async (_id, params, _signal, _update, ctx) => {
          current = ctx;
          return text(await controls.apply(params, ctx.hasUI, false, false, owner(ctx, _signal)));
        },
      });
      if (
        !process.argv.includes("--no-skills") &&
        readAidenSettings(agentDir).skillsEnabled !== false
      ) {
        pi.registerTool({
          name: "skill_aiden_app",
          label: "Aiden app skill",
          description: AIDEN_APP_SKILL.description,
          parameters: Type.Object({}),
          execute: async () => {
            if (readAidenSettings(agentDir).skillsEnabled === false)
              throw new Error("Skills are disabled.");
            return text(AIDEN_APP_SKILL.instructions);
          },
        });
      }
      pi.registerCommand("help-aiden", {
        description: "Read installed Aiden help",
        handler: async (query, ctx) => {
          ctx.ui.notify(JSON.stringify(readAidenHelp(query || "overview"), null, 2), "info");
        },
      });
      pi.registerCommand("aiden-app", {
        description: "Load the owned Aiden product skill",
        handler: async (_args, ctx) => {
          if (
            process.argv.includes("--no-skills") ||
            readAidenSettings(agentDir).skillsEnabled === false
          ) {
            ctx.ui.notify(
              "Skills are disabled. Product help remains available through /help-aiden.",
              "warning",
            );
            return;
          }
          pi.sendUserMessage(AIDEN_APP_SKILL.instructions);
        },
      });
      const openSettings = async (args: string, ctx: ExtensionContext, signal?: AbortSignal) => {
        current = ctx;
        const isCurrent = owner(ctx, signal);
        if (!ctx.hasUI) throw new Error("Settings controls require the interactive TUI.");
        const selected =
          args.trim() || (await ctx.ui.select("Aiden settings", [...APP_CONTROL_TOPICS]));
        if (!isAppControlTopic(selected)) return;
        const topic: AppControlTopic = selected;
        for (;;) {
          const snapshot = await controls.snapshot(topic, true, isCurrent);
          const labels = snapshot.rows.map(
            (row) =>
              `${row.label}: ${String(row.value)}${row.disabledReason ? " — unavailable" : ""}`,
          );
          const choice = await ctx.ui.select(`${snapshot.title} — This CLI`, [...labels, "Done"]);
          const index = choice ? labels.indexOf(choice) : -1;
          if (index < 0) break;
          const row = snapshot.rows[index];
          if (row.disabledReason) {
            ctx.ui.notify(row.disabledReason, "warning");
            continue;
          }
          const value = row.options
            ? await ctx.ui.select(
                row.label,
                row.options.map((option) => option.value),
              )
            : !row.value;
          if (value === undefined || value === row.value) continue;
          if (
            !(await ctx.ui.confirm(
              `Change ${row.label}?`,
              `This changes ${row.scope}. Existing permissions and setup still apply.`,
            ))
          )
            continue;
          try {
            const receipt = await controls.apply(
              { control: row.id, value, expectedRevision: row.revision, operationId: randomUUID() },
              true,
              true,
              false,
              isCurrent,
            );
            ctx.ui.notify(
              receipt.status === "outcome_unknown"
                ? "Change could not be confirmed; refresh before trying again."
                : (receipt.warning ?? "Saved."),
              receipt.status === "outcome_unknown" ? "warning" : "info",
            );
          } catch (error) {
            ctx.ui.notify(
              error instanceof Error ? error.message : "Change could not be confirmed.",
              "error",
            );
          }
        }
        ctx.ui.setWidget("aiden-controls", undefined);
      };
      pi.registerCommand("aiden-settings", {
        description: "Operate supported settings without leaving the conversation",
        handler: openSettings,
      });
      pi.registerTool({
        name: "aiden_open",
        label: "Open Aiden settings",
        description:
          "Open the interactive CLI's supported settings selector. Providers use the CLI's existing /model and aiden auth commands; no desktop window is controlled.",
        parameters: Type.Object({
          destination: Type.Union(
            [...APP_CONTROL_TOPICS, "providers"].map((value) => Type.Literal(value)),
          ),
        }),
        execute: async (_id, params, _signal, _update, ctx) => {
          if (!ctx.hasUI)
            return text({ status: "unavailable", command: `aiden app get ${params.destination}` });
          if (params.destination === "providers")
            return text({
              status: "available",
              commands: ["/model", "aiden auth list|login|logout", "aiden provider list"],
            });
          await openSettings(params.destination, ctx, _signal);
          return text({ status: "opened", destination: params.destination, target: "This CLI" });
        },
      });
    },
  };
}
