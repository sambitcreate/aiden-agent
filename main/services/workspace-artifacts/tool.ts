import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION, type AidenUiDiagnostic, type ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import { parseChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/visual.js";
import {
  describeWorkspaceArtifactCommands,
  isWorkspaceArtifactId,
  isWorkspaceArtifactTitle,
  parseWorkspaceArtifactActions,
  parseWorkspaceArtifactDescription,
  parseWorkspaceArtifactRefresh,
  parseWorkspaceArtifactSources,
  WORKSPACE_ARTIFACT_LIMITS,
  WORKSPACE_ARTIFACT_TOOL_NAME,
  workspaceArtifactHasCommands,
  type WorkspaceArtifactPermission,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactsChangedEvent,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactView,
} from "../../../renderer/shared/workspace-artifacts.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { workspaceArtifactDigest, type WorkspaceArtifactContent, type WorkspaceArtifactStore } from "./store.js";

export { WORKSPACE_ARTIFACT_TOOL_NAME };

const MAX_MARKUP_CHARS = 400_000;
const MAX_REPORTED_DIAGNOSTICS = 12;

type Operation = "create" | "update" | "list" | "delete";

interface ArtifactToolInput {
  operation?: unknown;
  id?: unknown;
  title?: unknown;
  description?: unknown;
  markup?: unknown;
  layout?: unknown;
  sources?: unknown;
  actions?: unknown;
  refresh?: unknown;
}

export interface WorkspaceArtifactToolOptions {
  workspaceId: string;
  chatId: string;
  permission: WorkspaceArtifactPermission;
  /** The workspace has a folder the tools may read. */
  hasFolder: boolean;
  store: Pick<WorkspaceArtifactStore, "list" | "get" | "create" | "replace" | "delete">;
  /** True when the person allowed this exact call on the chat approval card. */
  wasApproved?: (toolCallId: string) => boolean;
  /** Runs the artifact's sources once and returns each one's result. */
  refresh?: (
    artifact: WorkspaceArtifactV1,
    signal: AbortSignal | undefined,
  ) => Promise<Record<string, WorkspaceArtifactSourceResultV1>>;
  onChanged: (event: WorkspaceArtifactsChangedEvent) => void;
}

function operationOf(input: ArtifactToolInput): Operation {
  const value = input.operation;
  if (value === "create" || value === "update" || value === "list" || value === "delete") return value;
  throw new Error('operation must be "create", "update", "list" or "delete".');
}

function idOf(input: ArtifactToolInput): string {
  if (!isWorkspaceArtifactId(input.id)) throw new Error("Give the artifact id from workspace_artifact list.");
  return input.id;
}

function titleOf(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : value;
  if (!isWorkspaceArtifactTitle(title)) {
    throw new Error(`title must be 1–${WORKSPACE_ARTIFACT_LIMITS.titleChars} characters on one line.`);
  }
  return title;
}

function describeDiagnostics(diagnostics: readonly AidenUiDiagnostic[]): string {
  if (diagnostics.length === 0) return "";
  const lines = diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS).map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`);
  if (diagnostics.length > MAX_REPORTED_DIAGNOSTICS) lines.push(`- …and ${diagnostics.length - MAX_REPORTED_DIAGNOSTICS} more`);
  return `\nRepairs Aiden made to the page (fix these next time):\n${lines.join("\n")}`;
}

function compilePage(markup: unknown, layout: unknown, title: string): { visual: ChatUiVisualV1; diagnostics: AidenUiDiagnostic[] } {
  if (typeof markup !== "string" || !markup.trim()) throw new Error("markup is required: Aiden UI Markup starting with <Visual title=\"…\">.");
  if (markup.length > MAX_MARKUP_CHARS) throw new Error("markup is too long.");
  if (layout !== undefined && layout !== "column" && layout !== "wide") throw new Error('layout must be "column" or "wide".');
  const compiled = compileAum(markup, { artifactActions: true });
  if (!compiled.tree) throw new Error(`The markup produced no page.${describeDiagnostics(compiled.diagnostics)}`);
  const visual = parseChatUiVisualV1({
    version: 1,
    kind: "ui",
    id: "pending",
    title,
    catalogVersion: AIDEN_UI_CATALOG_VERSION,
    tree: compiled.tree,
    ...(compiled.dataJson ? { dataJson: compiled.dataJson } : {}),
    ...(compiled.state ? { state: compiled.state } : {}),
    fallbackText: compiled.fallbackText,
    ...(layout === "wide" ? { layout: "wide" } : {}),
  });
  if (!visual) throw new Error("The page is larger or more complex than an artifact can store; simplify it.");
  return { visual, diagnostics: compiled.diagnostics };
}

/** Rejects sources this workspace could never run, before anything is saved. */
function assertSourcesRunnable(
  content: Pick<WorkspaceArtifactContent, "sources" | "actions">,
  options: Pick<WorkspaceArtifactToolOptions, "permission" | "hasFolder">,
): void {
  if (content.sources.length === 0 && content.actions.length === 0) return;
  if (options.permission === "none" || !options.hasFolder) {
    throw new Error(
      "This workspace has no folder access, so its artifacts cannot read files or run commands. Put the data in <Data> instead, or ask the person to turn on workspace access.",
    );
  }
}

/** Every value the model may have changed, or the stored one where it said nothing. */
function contentFor(input: ArtifactToolInput, previous: WorkspaceArtifactV1 | undefined): {
  content: WorkspaceArtifactContent;
  diagnostics: AidenUiDiagnostic[];
} {
  const title = input.title === undefined && previous ? previous.visual.title : titleOf(input.title);
  const description =
    input.description === undefined ? previous?.description : parseWorkspaceArtifactDescription(input.description);
  const sources = input.sources === undefined && previous ? previous.sources : parseWorkspaceArtifactSources(input.sources);
  const actions = input.actions === undefined && previous ? previous.actions : parseWorkspaceArtifactActions(input.actions);
  const refresh = input.refresh === undefined && previous ? previous.refresh : parseWorkspaceArtifactRefresh(input.refresh);
  let visual: ChatUiVisualV1;
  let diagnostics: AidenUiDiagnostic[] = [];
  if (input.markup === undefined && previous) {
    const layout = input.layout === undefined ? previous.visual.layout : input.layout === "wide" ? "wide" : undefined;
    if (input.layout !== undefined && input.layout !== "column" && input.layout !== "wide") {
      throw new Error('layout must be "column" or "wide".');
    }
    const { layout: _previousLayout, ...rest } = previous.visual;
    visual = { ...rest, ...(layout === "wide" ? { layout } : {}) };
  } else {
    ({ visual, diagnostics } = compilePage(input.markup, input.layout ?? previous?.visual.layout, title));
  }
  return {
    content: { title, ...(description ? { description } : {}), visual, sources, actions, refresh },
    diagnostics,
  };
}

export interface WorkspaceArtifactCallApproval {
  required: boolean;
  summary?: string;
}

/**
 * Whether a call needs the person's approval in chat, and the card text.
 * Deleting always asks. Under Ask, saving commands the person has not
 * approved for this artifact asks, listing every command verbatim.
 * Invalid input asks nothing: the call then fails with the reason.
 */
export async function workspaceArtifactCallApproval(
  args: unknown,
  options: Pick<WorkspaceArtifactToolOptions, "workspaceId" | "permission" | "store">,
): Promise<WorkspaceArtifactCallApproval> {
  const input = (args && typeof args === "object" ? args : {}) as ArtifactToolInput;
  let operation: Operation;
  try {
    operation = operationOf(input);
  } catch {
    return { required: false };
  }
  if (operation === "list") return { required: false };
  if (operation === "delete") {
    if (!isWorkspaceArtifactId(input.id)) return { required: false };
    const existing = await options.store.get(options.workspaceId, input.id);
    if (!existing) return { required: false };
    return { required: true, summary: `Delete the artifact "${existing.artifact.visual.title}" from this workspace.` };
  }
  if (options.permission !== "ask") return { required: false };
  // Store reads may throw; the caller blocks the call rather than skip the card.
  const previous =
    operation === "update" && isWorkspaceArtifactId(input.id)
      ? (await options.store.get(options.workspaceId, input.id))?.artifact
      : undefined;
  if (operation === "update" && !previous) return { required: false };
  let sources: WorkspaceArtifactV1["sources"];
  let actions: WorkspaceArtifactV1["actions"];
  try {
    sources = input.sources === undefined && previous ? previous.sources : parseWorkspaceArtifactSources(input.sources);
    actions = input.actions === undefined && previous ? previous.actions : parseWorkspaceArtifactActions(input.actions);
  } catch {
    // Invalid input fails in execute with the reason; there is nothing to approve.
    return { required: false };
  }
  if (!workspaceArtifactHasCommands(sources, actions)) return { required: false };
  if (previous?.approvedDigest && previous.approvedDigest === workspaceArtifactDigest(sources, actions)) {
    return { required: false };
  }
  const title =
    input.title === undefined && previous ? previous.visual.title : typeof input.title === "string" ? input.title.trim() : "";
  const verb = operation === "create" ? "Create" : "Update";
  return {
    required: true,
    summary: `${verb} the artifact "${title}". It can run these commands in this workspace whenever it refreshes or you press its buttons:\n${describeWorkspaceArtifactCommands(sources, actions)}`,
  };
}

function describeSources(results: Record<string, WorkspaceArtifactSourceResultV1>): string {
  const lines = Object.entries(results).map(([name, result]) =>
    result.status === "ok"
      ? `- ${name}: ok`
      : result.status === "blocked"
        ? `- ${name}: not run (${result.error ?? "needs approval"})`
        : `- ${name}: failed: ${result.error ?? "unknown error"}`,
  );
  return lines.length ? `\nFirst refresh:\n${lines.join("\n")}` : "";
}

function listing(views: readonly WorkspaceArtifactView[]): string {
  if (views.length === 0) return "This workspace has no artifacts yet.";
  return JSON.stringify(
    views.map(({ artifact, snapshot }) => ({
      id: artifact.id,
      title: artifact.visual.title,
      ...(artifact.description ? { description: artifact.description } : {}),
      revision: artifact.revision,
      sources: artifact.sources.map((source) => ({
        name: source.name,
        kind: source.kind,
        ...(source.kind === "shell" ? { command: source.command } : { file: source.file }),
        parse: source.parse,
        ...(snapshot?.sources[source.name] ? { lastStatus: snapshot.sources[source.name]!.status } : {}),
      })),
      actions: artifact.actions.map((action) => ({ name: action.name, label: action.label, command: action.command, params: action.params })),
      refresh: artifact.refresh,
    })),
    null,
    2,
  );
}

function text(value: string): AgentToolResult<null> {
  return { content: [{ type: "text", text: value }], details: null };
}

/**
 * `workspace_artifact`: lets the model keep interactive pages in the
 * workspace's Artifacts tab. Approval happens before execution (see
 * `workspaceArtifactCallApproval`); the host reports allowed calls through
 * `wasApproved`, and only those record an approval for the commands.
 */
export function createWorkspaceArtifactTool(options: WorkspaceArtifactToolOptions): AgentTool {
  return declarePiRuntimeReplay(
    {
      name: WORKSPACE_ARTIFACT_TOOL_NAME,
      label: "Artifact",
      description:
        "Keep an interactive page in this workspace's Artifacts tab (beside the chat), for status the person will come back to: open pull requests, a release checklist, a TODO board. Unlike render_ui, the page persists for every chat in the workspace and re-reads live data from named sources (a shell command or a workspace file, bound in markup as $name) each time it refreshes. Always list first and update an existing artifact instead of creating a near-duplicate. Delete only when the person asks. Read the aiden-artifacts skill before the first call.",
      parameters: Type.Object({
        operation: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("list"), Type.Literal("delete")]),
        id: Type.Optional(Type.String({ description: "The artifact id from list; required for update and delete." })),
        title: Type.Optional(Type.String({ description: "Short visible name; required for create.", maxLength: 80 })),
        description: Type.Optional(Type.String({ description: "One line on what the page is for.", maxLength: 200 })),
        markup: Type.Optional(
          Type.String({
            description:
              "Aiden UI Markup for the page (same catalog as render_ui), starting with <Visual title=\"…\">. Source data binds as $name; a source that has not loaded yet is null. Buttons may call run(\"actionName\", value…) and compose(\"text\") as well as sendPrompt, openUrl, copy and setState. Required for create; omit on update to keep the page.",
          }),
        ),
        layout: Type.Optional(Type.Union([Type.Literal("column"), Type.Literal("wide")])),
        sources: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ description: "Identifier the page reads as $name." }),
              kind: Type.Union([Type.Literal("shell"), Type.Literal("file")]),
              command: Type.Optional(Type.String({ description: "kind shell: a read-only command run in the workspace folder." })),
              file: Type.Optional(Type.String({ description: "kind file: a workspace-relative path." })),
              parse: Type.Optional(Type.Union([Type.Literal("json"), Type.Literal("lines"), Type.Literal("text")])),
            }),
            { maxItems: WORKSPACE_ARTIFACT_LIMITS.sources },
          ),
        ),
        actions: Type.Optional(
          Type.Array(
            Type.Object({
              name: Type.String({ description: "Identifier buttons call as run(\"name\", …)." }),
              label: Type.String({ description: "What the button does, shown when the person confirms it." }),
              command: Type.String({ description: "Shell template; {{param}} is replaced with the quoted value." }),
              params: Type.Optional(
                Type.Array(
                  Type.Object({
                    name: Type.String(),
                    type: Type.Optional(Type.Union([Type.Literal("string"), Type.Literal("number")])),
                  }),
                ),
              ),
            }),
            { maxItems: WORKSPACE_ARTIFACT_LIMITS.actions },
          ),
        ),
        refresh: Type.Optional(
          Type.Object({
            onOpen: Type.Optional(Type.Boolean({ description: "Re-read sources when the page is shown (default true)." })),
            intervalSeconds: Type.Optional(
              Type.Number({ description: "Also re-read this often while the page is visible; at least 60." }),
            ),
          }),
        ),
      }),
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<null>> => {
        if (signal?.aborted) throw new Error("The artifact change was cancelled.");
        const input = (params ?? {}) as ArtifactToolInput;
        const operation = operationOf(input);
        const { workspaceId, chatId, store } = options;
        if (operation === "list") return text(listing(await store.list(workspaceId)));
        if (operation === "delete") {
          const id = idOf(input);
          const existing = await store.get(workspaceId, id);
          if (!existing) throw new Error("No artifact with that id exists in this workspace.");
          await store.delete(workspaceId, id);
          options.onChanged({ workspaceId, artifactId: id, reason: "deleted", chatId });
          return text(`Deleted the artifact "${existing.artifact.visual.title}".`);
        }
        const previous = operation === "update" ? (await store.get(workspaceId, idOf(input)))?.artifact : undefined;
        if (operation === "update" && !previous) throw new Error("No artifact with that id exists in this workspace.");
        const { content, diagnostics } = contentFor(input, previous);
        assertSourcesRunnable(content, options);
        // Only an allowed approval card covers new commands; otherwise an
        // unchanged set keeps the approval it already had.
        const approved = options.wasApproved?.(toolCallId) === true;
        if (signal?.aborted) throw new Error("The artifact change was cancelled.");
        const artifact = previous
          ? await store.replace(workspaceId, previous.id, content, { approved })
          : await store.create(workspaceId, content, { approved, chatId });
        options.onChanged({ workspaceId, artifactId: artifact.id, reason: previous ? "updated" : "created", chatId });
        let firstRefresh = "";
        if (options.refresh && artifact.sources.length > 0) {
          try {
            firstRefresh = describeSources(await options.refresh(artifact, signal));
          } catch (error) {
            firstRefresh = `\nFirst refresh failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const verb = previous ? "Updated" : "Created";
        return text(
          `${verb} the artifact "${artifact.visual.title}" (id ${artifact.id}, revision ${artifact.revision}). It is shown in this workspace's Artifacts tab.${firstRefresh}${describeDiagnostics(diagnostics)}`,
        );
      },
    },
    "never",
  );
}
