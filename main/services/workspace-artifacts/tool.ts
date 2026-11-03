import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { compileAum } from "../../../renderer/shared/aiden-ui/compile.js";
import { AIDEN_UI_CATALOG_VERSION, type AidenUiDiagnostic, type ChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/types.js";
import { parseChatUiVisualV1 } from "../../../renderer/shared/aiden-ui/visual.js";
import {
  describeWorkspaceArtifactCommands,
  isWorkspaceArtifactId,
  isWorkspaceArtifactRevision,
  isWorkspaceArtifactTitle,
  parseWorkspaceArtifactActions,
  parseWorkspaceArtifactDescription,
  parseWorkspaceArtifactRefresh,
  parseWorkspaceArtifactSources,
  resolveWorkspaceArtifactCommand,
  WORKSPACE_ARTIFACT_LIMITS,
  WORKSPACE_ARTIFACT_TOOL_NAME,
  workspaceArtifactCommandsNeedApproval,
  type WorkspaceArtifactPermission,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactsChangedEvent,
  workspaceArtifactCommandAccess,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactView,
} from "../../../renderer/shared/workspace-artifacts.js";
import type { ToolApprovalPreview } from "../../../renderer/shared/tool-approval-preview.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { checkWorkspaceArtifactPage, describeWorkspaceArtifactPageCheck } from "./check.js";
import type { WorkspaceArtifactActionResult } from "./runner.js";
import { workspaceArtifactDigest, type WorkspaceArtifactContent, type WorkspaceArtifactStore } from "./store.js";

export { WORKSPACE_ARTIFACT_TOOL_NAME };

const MAX_MARKUP_CHARS = 400_000;
const MAX_REPORTED_DIAGNOSTICS = 12;

type Operation = "create" | "update" | "list" | "delete" | "run" | "restore";

interface ArtifactToolInput {
  operation?: unknown;
  id?: unknown;
  revision?: unknown;
  title?: unknown;
  description?: unknown;
  markup?: unknown;
  layout?: unknown;
  sources?: unknown;
  actions?: unknown;
  refresh?: unknown;
  action?: unknown;
  args?: unknown;
}

export interface WorkspaceArtifactToolOptions {
  workspaceId: string;
  chatId: string;
  permission: WorkspaceArtifactPermission;
  /** The workspace has a folder the tools may read. */
  hasFolder: boolean;
  store: Pick<
    WorkspaceArtifactStore,
    "list" | "get" | "create" | "replace" | "delete" | "revision" | "restore" | "earlierRevisions"
  >;
  /**
   * Takes (once) the command digest an allowed approval card showed for this
   * call. A save records an approval only when its commands match it.
   */
  takeApprovedDigest?: (toolCallId: string) => string | undefined;
  /** False once the workspace was removed; a late call then writes nothing. */
  workspaceExists?: () => boolean | Promise<boolean>;
  /** Runs the artifact's sources once and returns each one's result. */
  refresh?: (
    artifact: WorkspaceArtifactV1,
    signal: AbortSignal | undefined,
  ) => Promise<Record<string, WorkspaceArtifactSourceResultV1>>;
  /**
   * Runs one of a saved page's actions, as its button would. A page whose
   * command digest is no longer `expectedDigest` does not run.
   */
  runAction?: (
    artifactId: string,
    actionName: string,
    args: readonly unknown[],
    expectedDigest: string,
    signal: AbortSignal | undefined,
  ) => Promise<WorkspaceArtifactActionResult>;
  onChanged: (event: WorkspaceArtifactsChangedEvent) => void;
}

function operationOf(input: ArtifactToolInput): Operation {
  const value = input.operation;
  if (
    value === "create" ||
    value === "update" ||
    value === "list" ||
    value === "delete" ||
    value === "run" ||
    value === "restore"
  ) {
    return value;
  }
  throw new Error('operation must be "create", "update", "list", "delete", "run" or "restore".');
}

function idOf(input: ArtifactToolInput): string {
  if (!isWorkspaceArtifactId(input.id)) throw new Error("Give the artifact id from workspace_artifact list.");
  return input.id;
}

function revisionNumberOf(input: ArtifactToolInput): number {
  if (!isWorkspaceArtifactRevision(input.revision)) {
    throw new Error("revision is required: one of the page's earlierRevisions from list.");
  }
  return input.revision;
}

/** The action a run call names on a page, and the values it passes. */
function runTarget(input: ArtifactToolInput, artifact: WorkspaceArtifactV1) {
  if (typeof input.action !== "string" || !input.action) throw new Error("action is required: the name of one of the page's actions.");
  const action = artifact.actions.find((entry) => entry.name === input.action);
  if (!action) {
    const names = artifact.actions.map((entry) => entry.name).join(", ");
    throw new Error(`This page has no action named "${input.action}"${names ? ` (its actions: ${names})` : ""}.`);
  }
  if (input.args !== undefined && !Array.isArray(input.args)) throw new Error("args must be a list of values, one per param.");
  const args: unknown[] = input.args ?? [];
  // Throws with the reason when the values do not fit the action's params.
  const { preview } = resolveWorkspaceArtifactCommand(action, args);
  return { action, args, preview };
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

/** The sources and actions the call would save: the stored ones where it said nothing. */
function commandsFor(
  input: ArtifactToolInput,
  previous: WorkspaceArtifactV1 | undefined,
): Pick<WorkspaceArtifactV1, "sources" | "actions"> {
  return {
    sources: input.sources === undefined && previous ? previous.sources : parseWorkspaceArtifactSources(input.sources),
    actions: input.actions === undefined && previous ? previous.actions : parseWorkspaceArtifactActions(input.actions),
  };
}

/** Every value the model may have changed, or the stored one where it said nothing. */
function contentFor(input: ArtifactToolInput, previous: WorkspaceArtifactV1 | undefined): {
  content: WorkspaceArtifactContent;
  diagnostics: AidenUiDiagnostic[];
} {
  const title = input.title === undefined && previous ? previous.visual.title : titleOf(input.title);
  const description =
    input.description === undefined ? previous?.description : parseWorkspaceArtifactDescription(input.description);
  const { sources, actions } = commandsFor(input, previous);
  const refresh = input.refresh === undefined && previous ? previous.refresh : parseWorkspaceArtifactRefresh(input.refresh);
  let visual: ChatUiVisualV1;
  let diagnostics: AidenUiDiagnostic[] = [];
  if (input.markup === undefined && previous) {
    if (input.layout !== undefined && input.layout !== "column" && input.layout !== "wide") {
      throw new Error('layout must be "column" or "wide".');
    }
    const layout = input.layout === undefined ? previous.visual.layout : input.layout === "wide" ? "wide" : undefined;
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
  /**
   * What an allowed card covers, handed back to the tool: the commands a save
   * listed, or for a run the page and the exact resolved command it showed.
   */
  digest?: string;
  /** For a run, the resolved command, shown as the card's command. */
  preview?: ToolApprovalPreview;
}

/**
 * What a run card covers: this page's commands and the exact command the card
 * showed. A card allowed for a save, another action or other values never
 * matches, so it cannot authorize this run.
 */
function runApprovalDigest(pageDigest: string, command: string): string {
  return createHash("sha256").update(JSON.stringify({ run: pageDigest, command })).digest("hex");
}

/**
 * The card for saving a page that can run these commands, or none when it
 * runs nothing or the page already allows exactly these commands. The same
 * test marks a version as needing allowing again in the tab.
 */
function commandsCard(
  what: string,
  sources: WorkspaceArtifactV1["sources"],
  actions: WorkspaceArtifactV1["actions"],
  approvedDigest: string | undefined,
): WorkspaceArtifactCallApproval {
  const digest = workspaceArtifactDigest(sources, actions);
  if (!workspaceArtifactCommandsNeedApproval(sources, actions, digest, approvedDigest)) return { required: false };
  return {
    required: true,
    digest,
    summary: `${what}. It can run these commands in this workspace whenever it refreshes or you press its buttons:\n${describeWorkspaceArtifactCommands(sources, actions)}`,
  };
}

/**
 * Whether a call needs the person's approval in chat, and the card text.
 * Deleting always asks. Under Ask, saving commands the person has not
 * approved for this artifact asks, listing every command verbatim, and every
 * run asks with the exact command, as a button press does.
 * Invalid input, or a run that cannot happen, asks nothing: the call then
 * fails with the reason.
 */
export async function workspaceArtifactCallApproval(
  args: unknown,
  options: Pick<WorkspaceArtifactToolOptions, "workspaceId" | "permission" | "store" | "hasFolder">,
): Promise<WorkspaceArtifactCallApproval> {
  const input = (args && typeof args === "object" ? args : {}) as ArtifactToolInput;
  let operation: Operation;
  try {
    operation = operationOf(input);
  } catch {
    return { required: false };
  }
  if (operation === "list") return { required: false };
  if (operation === "run") {
    // Under Ask the person confirms each run with the exact command, as they
    // would a button press. Elsewhere, or for a call that cannot run, there is
    // nothing to confirm: execute runs it or fails with the reason.
    if (options.permission !== "ask" || !options.hasFolder || !isWorkspaceArtifactId(input.id)) return { required: false };
    const view = await options.store.get(options.workspaceId, input.id);
    if (!view || view.artifact.approvedDigest !== view.digest) return { required: false };
    let target: ReturnType<typeof runTarget>;
    try {
      target = runTarget(input, view.artifact);
    } catch {
      return { required: false };
    }
    return {
      required: true,
      digest: runApprovalDigest(view.digest, target.preview),
      // The title is quoted so it cannot pose as extra lines of the card.
      summary: `Run "${target.action.label}" from the artifact ${JSON.stringify(view.artifact.visual.title)}.`,
      preview: { kind: "command", command: target.preview },
    };
  }
  if (operation === "delete") {
    if (!isWorkspaceArtifactId(input.id)) return { required: false };
    const existing = await options.store.get(options.workspaceId, input.id);
    if (!existing) return { required: false };
    return { required: true, summary: `Delete the artifact "${existing.artifact.visual.title}" from this workspace.` };
  }
  if (options.permission !== "ask") return { required: false };
  if (operation === "restore") {
    // A restore that brings back commands other than the approved ones asks,
    // exactly as an update with those commands would.
    if (!isWorkspaceArtifactId(input.id)) return { required: false };
    let revision: number;
    try {
      revision = revisionNumberOf(input);
    } catch {
      return { required: false };
    }
    const view = await options.store.get(options.workspaceId, input.id);
    const entry = view ? await options.store.revision(options.workspaceId, input.id, revision) : undefined;
    if (!view || !entry) return { required: false };
    return commandsCard(
      `Restore revision ${revision} of the artifact "${view.artifact.visual.title}"`,
      entry.sources,
      entry.actions,
      view.artifact.approvedDigest,
    );
  }
  // Store reads may throw; the caller blocks the call rather than skip the card.
  const previous =
    operation === "update" && isWorkspaceArtifactId(input.id)
      ? (await options.store.get(options.workspaceId, input.id))?.artifact
      : undefined;
  if (operation === "update" && !previous) return { required: false };
  let sources: WorkspaceArtifactV1["sources"];
  let actions: WorkspaceArtifactV1["actions"];
  try {
    ({ sources, actions } = commandsFor(input, previous));
  } catch {
    // Invalid input fails in execute with the reason; there is nothing to approve.
    return { required: false };
  }
  const title =
    input.title === undefined && previous ? previous.visual.title : typeof input.title === "string" ? input.title.trim() : "";
  const verb = operation === "create" ? "Create" : "Update";
  return commandsCard(`${verb} the artifact "${title}"`, sources, actions, previous?.approvedDigest);
}

function describeSources(results: Record<string, WorkspaceArtifactSourceResultV1>, heading = "First refresh"): string {
  const lines = Object.entries(results).map(([name, result]) =>
    result.status === "ok"
      ? `- ${name}: ok`
      : result.status === "blocked"
        ? `- ${name}: not run (${result.error ?? "needs approval"})`
        : `- ${name}: failed: ${result.error ?? "unknown error"}`,
  );
  return lines.length ? `\n${heading}:\n${lines.join("\n")}` : "";
}

function listing(views: readonly WorkspaceArtifactView[], earlier: Record<string, number[]>): string {
  if (views.length === 0) return "This workspace has no artifacts yet.";
  return JSON.stringify(
    views.map(({ artifact, snapshot }) => ({
      id: artifact.id,
      title: artifact.visual.title,
      ...(artifact.description ? { description: artifact.description } : {}),
      revision: artifact.revision,
      ...(earlier[artifact.id]?.length ? { earlierRevisions: earlier[artifact.id] } : {}),
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
 * workspace's Artifacts tab and run their actions. Approval happens before
 * execution (see `workspaceArtifactCallApproval`); the host reports allowed
 * calls through `takeApprovedDigest`. Only those record an approval for the
 * commands a save showed, and under Ask only those run an action.
 */
export function createWorkspaceArtifactTool(options: WorkspaceArtifactToolOptions): AgentTool {
  /**
   * After a save: the first refresh, then the page checked against its data.
   * The page is already saved, so neither may make the save look failed.
   */
  async function afterSave(artifact: WorkspaceArtifactV1, signal: AbortSignal | undefined): Promise<string> {
    let firstRefresh = "";
    let results: Record<string, WorkspaceArtifactSourceResultV1> | undefined;
    if (options.refresh && artifact.sources.length > 0) {
      try {
        results = await options.refresh(artifact, signal);
        firstRefresh = describeSources(results);
      } catch (error) {
        firstRefresh = `\nFirst refresh failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let pageCheck: string;
    try {
      pageCheck = describeWorkspaceArtifactPageCheck(checkWorkspaceArtifactPage(artifact, results));
    } catch {
      pageCheck = "\nPage check unavailable.";
    }
    return `${firstRefresh}${pageCheck}`;
  }

  async function runPageAction(input: ArtifactToolInput, shownDigest: string | undefined, signal: AbortSignal | undefined) {
    const view = await options.store.get(options.workspaceId, idOf(input));
    if (!view) throw new Error("No artifact with that id exists in this workspace.");
    if (!options.runAction) throw new Error("This chat cannot run artifact actions.");
    const { action, args, preview } = runTarget(input, view.artifact);
    if (!options.hasFolder) throw new Error("This workspace has no folder, so its pages' actions can't run.");
    const approved = view.artifact.approvedDigest === view.digest;
    const access = workspaceArtifactCommandAccess(options.permission, options.hasFolder, approved);
    if (access === "blocked") throw new Error("Workspace access is off, so this page's actions can't run.");
    if (access === "needs-approval") {
      throw new Error("The person has not allowed this page's commands yet; they can allow them in the Artifacts tab.");
    }
    // Under Ask only a confirmed card runs, and only the exact command on this page it showed.
    if (options.permission === "ask") {
      if (shownDigest === undefined) throw new Error("The person did not confirm this run.");
      if (shownDigest !== runApprovalDigest(view.digest, preview)) {
        throw new Error("This page changed after the person confirmed the run. Try again.");
      }
    }
    const result = await options.runAction(view.artifact.id, action.name, args, view.digest, signal);
    let refreshed = "";
    if (options.refresh && view.artifact.sources.length > 0) {
      try {
        refreshed = describeSources(await options.refresh(view.artifact, signal), "Refresh after the run");
      } catch (error) {
        refreshed = `\nRefresh after the run failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const output = result.output ? `\nOutput:\n${result.output}` : "";
    // A failed command fails the tool call, so the chat and the model see it as failed.
    if (!result.ok) throw new Error(`"${action.label}" failed.${output}${refreshed}`);
    return `Ran "${action.label}".${output}${refreshed}`;
  }

  return declarePiRuntimeReplay(
    {
      name: WORKSPACE_ARTIFACT_TOOL_NAME,
      label: "Artifact",
      description:
        "Keep an interactive page in this workspace's Artifacts tab (beside the chat), for status the person will come back to: open pull requests, a release checklist, a TODO board. Unlike render_ui, the page persists for every chat in the workspace and re-reads live data from named sources (a shell command or a workspace file, bound in markup as $name) each time it refreshes. Always list first and update an existing artifact instead of creating a near-duplicate. Delete only when the person asks. run performs one of a page's actions exactly as its button would; use it only when the person asks for that action. restore brings back one of the page's earlierRevisions (from list) as a new revision, keeping its current title; use it when the person wants to undo or go back to an earlier version. Read the aiden-artifacts skill before the first call.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("delete"),
          Type.Literal("run"),
          Type.Literal("restore"),
        ]),
        id: Type.Optional(Type.String({ description: "The artifact id from list; required for update, delete, run and restore." })),
        revision: Type.Optional(
          Type.Integer({ description: "restore: one of the page's earlierRevisions from list.", minimum: 1 }),
        ),
        action: Type.Optional(Type.String({ description: "run: the name of the page's action, from list." })),
        args: Type.Optional(
          Type.Array(Type.Union([Type.String(), Type.Number()]), {
            description: "run: one value per param of the action, in order.",
            maxItems: WORKSPACE_ARTIFACT_LIMITS.params,
          }),
        ),
        title: Type.Optional(Type.String({ description: "Short visible name; required for create.", maxLength: WORKSPACE_ARTIFACT_LIMITS.titleChars })),
        description: Type.Optional(Type.String({ description: "One line on what the page is for.", maxLength: WORKSPACE_ARTIFACT_LIMITS.descriptionChars })),
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
              command: Type.String({ description: "Shell template; each {{param}}, a standalone unquoted word, becomes the value as one literal argument." }),
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
        // Consumed before anything can fail, so an entry never outlives its call.
        const shownDigest = options.takeApprovedDigest?.(toolCallId);
        if (signal?.aborted) throw new Error("Cancelled.");
        const input = (params ?? {}) as ArtifactToolInput;
        const operation = operationOf(input);
        const { workspaceId, chatId, store } = options;
        if (options.workspaceExists && !(await options.workspaceExists())) {
          throw new Error("This workspace no longer exists.");
        }
        if (operation === "list") {
          const [views, earlier] = await Promise.all([store.list(workspaceId), store.earlierRevisions(workspaceId)]);
          return text(listing(views, earlier));
        }
        if (operation === "run") return text(await runPageAction(input, shownDigest, signal));
        if (operation === "restore") {
          const id = idOf(input);
          const revision = revisionNumberOf(input);
          const current = await store.get(workspaceId, id);
          if (!current) throw new Error("No artifact with that id exists in this workspace.");
          const entry = await store.revision(workspaceId, id, revision);
          if (!entry) {
            throw new Error(`Revision ${revision} of this artifact is no longer kept. List the artifact for its earlierRevisions.`);
          }
          assertSourcesRunnable(entry, options);
          if (signal?.aborted) throw new Error("The restore was cancelled.");
          // The store approves only when the allowed card listed exactly the restored commands.
          const artifact = await store.restore(workspaceId, id, revision, { approvedDigest: shownDigest });
          options.onChanged({ workspaceId, artifactId: artifact.id, reason: "updated", chatId });
          return text(
            `Restored revision ${revision} of the artifact "${artifact.visual.title}" as revision ${artifact.revision}.${await afterSave(artifact, signal)}`,
          );
        }
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
        if (signal?.aborted) throw new Error("The artifact change was cancelled.");
        // The store approves only when the allowed card listed exactly the saved
        // commands; otherwise an unchanged set keeps the approval it already had.
        const artifact = previous
          ? await store.replace(workspaceId, previous.id, content, { approvedDigest: shownDigest })
          : await store.create(workspaceId, content, { approvedDigest: shownDigest, chatId });
        options.onChanged({ workspaceId, artifactId: artifact.id, reason: previous ? "updated" : "created", chatId });
        const verb = previous ? "Updated" : "Created";
        return text(
          `${verb} the artifact "${artifact.visual.title}" (id ${artifact.id}, revision ${artifact.revision}). It is shown in this workspace's Artifacts tab.${await afterSave(artifact, signal)}${describeDiagnostics(diagnostics)}`,
        );
      },
    },
    "never",
  );
}
