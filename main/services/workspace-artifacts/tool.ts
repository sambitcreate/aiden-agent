import { createHash } from "node:crypto";
import { assertArtifactFilePath } from "./file-policy.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
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
  safeCut,
  workspaceArtifactActionProblem,
  WORKSPACE_ARTIFACT_LIMITS,
  WORKSPACE_ARTIFACT_TOOL_NAME,
  workspaceArtifactCommandsNeedApproval,
  type WorkspaceArtifactPermission,
  type WorkspaceArtifactSourceResultV1,
  type WorkspaceArtifactSourceV1,
  type WorkspaceArtifactsChangedEvent,
  workspaceArtifactCommandAccess,
  type WorkspaceArtifactV1,
  type WorkspaceArtifactView,
} from "../../../renderer/shared/workspace-artifacts.js";
import type { ToolApprovalPreview } from "../../../renderer/shared/tool-approval-preview.js";
import { declarePiRuntimeReplay } from "../pi-runtime-tool.js";
import { declareOnDemandSummary } from "../on-demand-tools.js";
import { applyMarkupEdits, MAX_MARKUP_EDITS, parseMarkupEdits } from "../markup-edits.js";
import { checkWorkspaceArtifactPage, describeWorkspaceArtifactPageCheck } from "./check.js";
import { describeSourceData } from "./data-shape.js";
import type { WorkspaceArtifactActionResult } from "./runner.js";
import {
  workspaceArtifactDigest,
  type WorkspaceArtifactContent,
  type WorkspaceArtifactRevisionV1,
  type WorkspaceArtifactStore,
} from "./store.js";

export { WORKSPACE_ARTIFACT_TOOL_NAME };

const MAX_MARKUP_CHARS = WORKSPACE_ARTIFACT_LIMITS.markupChars;
const MARKUP_LIMIT = `${MAX_MARKUP_CHARS.toLocaleString("en-US")}-character limit`;
const MAX_REPORTED_DIAGNOSTICS = 12;

type Operation = "create" | "update" | "list" | "get" | "check" | "delete" | "run" | "restore";

/** Why `get` has no markup to show, and what to do instead. */
const MARKUP_NOT_KEPT = "Aiden did not keep this version's markup: it was saved before Aiden kept page markup, or imported from a file. To change the page, send the whole markup in an update.";
/** The same, for a version whose markup was dropped to keep the workspace's files within their size. */
const MARKUP_DROPPED = "Aiden dropped this version's markup to keep this workspace's saved pages within their storage limit (the least recently changed pages' markup goes first); the page itself is unchanged. To change the page, send the whole markup in an update.";

function noMarkupReason(page: Pick<WorkspaceArtifactV1, "markupDropped">): string {
  return page.markupDropped ? MARKUP_DROPPED : MARKUP_NOT_KEPT;
}

interface ArtifactToolInput {
  operation?: unknown;
  id?: unknown;
  revision?: unknown;
  baseVersion?: unknown;
  title?: unknown;
  description?: unknown;
  markup?: unknown;
  edits?: unknown;
  layout?: unknown;
  sources?: unknown;
  actions?: unknown;
  refresh?: unknown;
  action?: unknown;
  args?: unknown;
  offset?: unknown;
  length?: unknown;
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
  /**
   * Runs the artifact's sources once and returns each one's result. After a
   * save, `reuseFrom` is the page as it was before: a source the save left
   * unchanged keeps a read that is still fresh instead of running again.
   */
  refresh?: (
    artifact: WorkspaceArtifactV1,
    signal: AbortSignal | undefined,
    reuseFrom?: WorkspaceArtifactV1,
  ) => Promise<Record<string, WorkspaceArtifactSourceResultV1>>;
  /**
   * Runs these sources once and saves nothing, for `check`. `approved` says
   * whether the person allowed these exact shell commands.
   */
  check?: (
    sources: readonly WorkspaceArtifactSourceV1[],
    approved: boolean,
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
    value === "get" ||
    value === "check" ||
    value === "delete" ||
    value === "run" ||
    value === "restore"
  ) {
    return value;
  }
  throw new Error('operation must be "create", "update", "list", "get", "check", "delete", "run" or "restore".');
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
  return `\nRepairs Aiden made to the page (the page saved with them; if one changed what you meant, update the page now, and avoid them from now on):\n${lines.join("\n")}`;
}

function compilePage(markup: unknown, layout: unknown, title: string): { visual: ChatUiVisualV1; diagnostics: AidenUiDiagnostic[] } {
  if (typeof markup !== "string" || !markup.trim()) throw new Error("markup is required: Aiden UI Markup starting with <Visual title=\"…\">.");
  if (markup.length > MAX_MARKUP_CHARS) throw new Error(`markup is ${markup.length.toLocaleString("en-US")} characters, over the ${MARKUP_LIMIT}: split the page or drop repeated content. To change a saved page, send edits rather than the whole markup.`);
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
  for (const source of content.sources) if (source.kind === "file") assertArtifactFilePath(source.file);
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

/** The stored page, with the layout the call set. */
function keptPage(input: ArtifactToolInput, previous: WorkspaceArtifactV1): ChatUiVisualV1 {
  if (input.layout !== undefined && input.layout !== "column" && input.layout !== "wide") {
    throw new Error('layout must be "column" or "wide".');
  }
  const layout = input.layout === undefined ? previous.visual.layout : input.layout;
  const { layout: _previousLayout, ...rest } = previous.visual;
  return { ...rest, ...(layout === "wide" ? { layout } : {}) };
}

/**
 * `content` with every value the call left out taken again from `current`,
 * the page as the store holds it under its lock, so another chat's save that
 * landed after `content` was built is not written over. The title and
 * description are settled by the store's `base` check instead.
 */
function rebasedContent(
  input: ArtifactToolInput,
  content: WorkspaceArtifactContent,
  current: WorkspaceArtifactV1,
): WorkspaceArtifactContent {
  const next: WorkspaceArtifactContent = { ...content };
  if (input.sources === undefined) next.sources = current.sources;
  if (input.actions === undefined) next.actions = current.actions;
  if (input.refresh === undefined) next.refresh = current.refresh;
  if (input.markup === undefined) {
    next.visual = keptPage(input, current);
    if (current.initialState) next.initialState = current.initialState;
    else delete next.initialState;
    if (current.markup !== undefined) next.markup = current.markup;
    else delete next.markup;
    if (current.markupDropped && current.markup === undefined) next.markupDropped = true;
    else delete next.markupDropped;
  } else if (input.layout === undefined) {
    // New markup keeps the layout the page has now.
    const { layout: _compiledLayout, ...rest } = content.visual;
    next.visual = { ...rest, ...(current.visual.layout === "wide" ? { layout: "wide" } : {}) };
  }
  return next;
}

/**
 * The call with its `edits` applied to `markup`, the saved page's markup, so
 * the rest of a save reads it as a call that sent the whole edited markup.
 * Any edit that misses throws, and nothing is saved.
 */
function withEdits(input: ArtifactToolInput, page: Pick<WorkspaceArtifactV1, "markup" | "markupDropped"> | undefined): ArtifactToolInput {
  if (input.edits === undefined) return input;
  if (input.markup !== undefined) throw new Error("Send either markup or edits, not both.");
  if (!page) throw new Error("edits change a saved page: give its id, or send the whole markup to create one.");
  const edits = parseMarkupEdits(input.edits);
  if (page.markup === undefined) throw new Error(noMarkupReason(page));
  const { edits: _edits, ...rest } = input;
  const markup = applyMarkupEdits(page.markup, edits, "Read the page's markup again with get, then retry.");
  if (markup.length > MAX_MARKUP_CHARS) {
    throw new Error(`The edits make the markup ${markup.length.toLocaleString("en-US")} characters, over the ${MARKUP_LIMIT}: make them remove more than they add, or split the page or drop repeated content. Nothing was saved.`);
  }
  return { ...rest, markup };
}

/** Reads `baseVersion`: the revision the call's change was prepared from, if it names one. */
function baseVersionOf(input: ArtifactToolInput, operation: Operation): number | undefined {
  if (input.baseVersion === undefined) return undefined;
  if (operation !== "update") throw new Error("baseVersion goes with update: the revision of the page you read.");
  if (!isWorkspaceArtifactRevision(input.baseVersion)) {
    throw new Error("baseVersion must be the page's revision number, from get or list.");
  }
  return input.baseVersion;
}

/** What this tool's saves did to a page in this turn: from `from` up to `revision`. */
interface TurnSaves {
  /** The revision the turn's first save (since another save landed) replaced. */
  from: number;
  revision: number;
  title: string;
}

/**
 * Whether a page at `current` is still the page `baseVersion` named: the same
 * revision, or one only this turn's own saves moved it to since.
 */
function baseVersionHolds(baseVersion: number, current: WorkspaceArtifactV1, turn: TurnSaves | undefined): boolean {
  if (current.revision === baseVersion) return true;
  return turn !== undefined && turn.revision === current.revision && baseVersion >= turn.from && baseVersion < turn.revision;
}

type PageVersion = Pick<WorkspaceArtifactRevisionV1, "description" | "visual" | "markup" | "sources" | "actions" | "refresh">;

/** The parts that differ between two versions of a page, in words. */
function changedParts(from: PageVersion, to: PageVersion): string[] {
  const page = (version: PageVersion) => {
    const { id: _id, title: _title, state: _state, ...rest } = version.visual;
    return JSON.stringify(rest);
  };
  const parts: string[] = [];
  if (from.visual.title !== to.visual.title) parts.push("name");
  if ((from.description ?? "") !== (to.description ?? "")) parts.push("description");
  if (page(from) !== page(to) || (from.markup !== undefined && to.markup !== undefined && from.markup !== to.markup)) {
    parts.push("page");
  }
  if (JSON.stringify(from.sources) !== JSON.stringify(to.sources)) parts.push("data sources");
  if (JSON.stringify(from.actions) !== JSON.stringify(to.actions)) parts.push("actions");
  if (JSON.stringify(from.refresh) !== JSON.stringify(to.refresh)) parts.push("refresh settings");
  return parts;
}

function joinedWords(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Thrown under the store's lock when the page moved past the call's baseVersion. */
class BaseVersionMoved extends Error {
  constructor(readonly current: WorkspaceArtifactV1) {
    super("The artifact changed since baseVersion.");
  }
}

/**
 * The refusal for a save prepared from `baseVersion` when the page is now at
 * `current`: what changed in between, where the store still keeps that
 * version, and the revision to read again.
 */
async function baseVersionRefusal(
  baseVersion: number,
  current: WorkspaceArtifactV1,
  earlierVersion: (revision: number) => Promise<PageVersion | undefined>,
): Promise<string> {
  const name = JSON.stringify(current.visual.title);
  const again = `Nothing was saved. Read it again with get and make the change against revision ${current.revision}.`;
  if (baseVersion > current.revision) {
    return `The artifact ${name} has no revision ${baseVersion}; it is at revision ${current.revision}. ${again}`;
  }
  let what = "";
  try {
    const before = await earlierVersion(baseVersion);
    const parts = before ? changedParts(before, current) : [];
    if (parts.length) what = ` Its ${joinedWords(parts)} changed.`;
  } catch {
    // The refusal stands without the detail.
  }
  return `The artifact ${name} changed since revision ${baseVersion}, in another chat or by the person: it is now revision ${current.revision}.${what} ${again}`;
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
  let initialState: Record<string, unknown> | undefined;
  let diagnostics: AidenUiDiagnostic[] = [];
  let markup: string | undefined;
  let markupDropped = false;
  if (input.markup === undefined && previous) {
    initialState = previous.initialState;
    visual = keptPage(input, previous);
    markup = previous.markup;
    markupDropped = previous.markupDropped === true;
  } else {
    ({ visual, diagnostics } = compilePage(input.markup, input.layout ?? previous?.visual.layout, title));
    // A fresh compile's state is what the markup declared; compilePage
    // refused markup longer than a version keeps.
    initialState = visual.state;
    markup = input.markup as string;
  }
  return {
    content: {
      title,
      ...(description ? { description } : {}),
      visual,
      ...(markup !== undefined ? { markup } : {}),
      ...(markup === undefined && markupDropped ? { markupDropped: true as const } : {}),
      ...(initialState ? { initialState } : {}),
      sources,
      actions,
      refresh,
    },
    diagnostics,
  };
}

/** What a check runs and draws: the page as the call would save it, or bare sources to try. */
interface CheckTarget {
  sources: WorkspaceArtifactSourceV1[];
  page?: Pick<WorkspaceArtifactV1, "visual" | "sources" | "actions">;
  diagnostics: AidenUiDiagnostic[];
}

/**
 * The sources and page a check covers. On a page, values the call left out
 * are the saved ones, exactly as an update would build them; without an id
 * the call tries the sources it gives, and draws markup it gives with them.
 */
function checkTarget(
  input: ArtifactToolInput,
  previous: WorkspaceArtifactV1 | undefined,
  options: Pick<WorkspaceArtifactToolOptions, "permission" | "hasFolder">,
): CheckTarget {
  let target: CheckTarget;
  input = withEdits(input, previous);
  if (previous || input.markup !== undefined) {
    const { content, diagnostics } = contentFor(previous ? input : { ...input, title: input.title ?? "Check" }, previous);
    target = { sources: content.sources, page: content, diagnostics };
  } else {
    if (input.sources === undefined) throw new Error("check needs the id of a page, or the sources to try.");
    target = { sources: parseWorkspaceArtifactSources(input.sources), diagnostics: [] };
  }
  assertSourcesRunnable({ sources: target.sources, actions: [] }, options);
  return target;
}

/** Whether the person already allowed these sources: the page's approval covers exactly them. */
function checkPageApproved(sources: readonly WorkspaceArtifactSourceV1[], previous: WorkspaceArtifactV1 | undefined): boolean {
  return (
    previous?.approvedDigest !== undefined && previous.approvedDigest === workspaceArtifactDigest(sources, previous.actions)
  );
}

/** What a check card covers: running these sources once. It never approves a save. */
function checkApprovalDigest(sources: readonly WorkspaceArtifactSourceV1[]): string {
  return createHash("sha256").update(JSON.stringify({ check: workspaceArtifactDigest(sources, []) })).digest("hex");
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
 * Invalid input, a save that would fail (see `assertSaveValid`), or a run
 * that cannot happen asks nothing: the call then fails with the reason.
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
  if (operation === "list" || operation === "get") return { required: false };
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
  if (operation === "check") {
    // Under Ask, running shell sources the person has not allowed for this
    // page asks first, listing them, exactly as saving them would.
    const previous = isWorkspaceArtifactId(input.id) ? (await options.store.get(options.workspaceId, input.id))?.artifact : undefined;
    if (input.id !== undefined && !previous) return { required: false };
    let target: CheckTarget;
    try {
      target = checkTarget(input, previous, options);
    } catch {
      return { required: false };
    }
    if (!target.sources.some((source) => source.kind === "shell") || checkPageApproved(target.sources, previous)) {
      return { required: false };
    }
    const what = previous ? `the artifact ${JSON.stringify(previous.visual.title)}` : "a new artifact's sources";
    return {
      required: true,
      digest: checkApprovalDigest(target.sources),
      summary: `Check ${what}: run these commands once in this workspace. Nothing is saved.\n${describeWorkspaceArtifactCommands(target.sources, [])}`,
    };
  }
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
  const card = commandsCard(`${verb} the artifact "${title}"`, sources, actions, previous?.approvedDigest);
  if (!card.required) return card;
  try {
    assertSaveValid(input, operation, previous, options);
  } catch {
    // A save that would fail anyway shows no card: the call fails with the reason before anyone is asked.
    return { required: false };
  }
  return card;
}

/**
 * Throws what execute would refuse a create or update for, against the page
 * as saved now: a bad baseVersion, edits that miss, markup that does not
 * compile or is too long, and values or sources that are not valid here. A
 * baseVersion behind the page is left to execute, which alone knows whether
 * only the reply's own earlier saves moved it.
 */
function assertSaveValid(
  input: ArtifactToolInput,
  operation: Operation,
  previous: WorkspaceArtifactV1 | undefined,
  options: Pick<WorkspaceArtifactToolOptions, "permission" | "hasFolder">,
): void {
  const baseVersion = baseVersionOf(input, operation);
  if (previous && baseVersion !== undefined && baseVersion > previous.revision) {
    throw new Error("baseVersion is ahead of the page.");
  }
  const { content } = contentFor(withEdits(input, previous), previous);
  assertSourcesRunnable(content, options);
}

/**
 * One line per source result; a source that loaded also gives its data's
 * shape. A read from before `since` was kept from an earlier refresh.
 */
function describeSources(
  results: Record<string, WorkspaceArtifactSourceResultV1>,
  heading = "First refresh",
  since?: number,
): string {
  const lines = Object.entries(results).map(([name, result]) => {
    if (result.status === "ok") {
      const data = describeSourceData(result.dataJson);
      const kept =
        since !== undefined && result.at < since
          ? ` (unchanged, so its read from ${Math.max(1, Math.round((since - result.at) / 1000))}s ago was kept)`
          : "";
      return `- ${name}: ok${kept}${data ? `, ${data.shape}` : ""}`;
    }
    return result.status === "blocked"
      ? `- ${name}: not run (${result.error ?? "needs approval"})`
      : `- ${name}: failed: ${result.error ?? "unknown error"}`;
  });
  return lines.length ? `\n${heading}:\n${lines.join("\n")}` : "";
}

/** A saved result that failed but whose page still shows the data an earlier read left. */
function isStale(result: WorkspaceArtifactSourceResultV1 | undefined): boolean {
  return result !== undefined && result.status !== "ok" && result.dataJson !== undefined;
}

/** Reads `offset` and `length`: a slice of the markup, the whole of it by default. */
function markupSlice(input: ArtifactToolInput, markup: string): { start: number; end: number } {
  const integer = (value: unknown, name: string, min: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
      throw new Error(`${name} must be a whole number of at least ${min}.`);
    }
    return value;
  };
  const start = integer(input.offset, "offset", 0) ?? 0;
  const length = integer(input.length, "length", 1);
  if (start > 0 && start >= markup.length) {
    throw new Error(`offset ${start} is past the end of the markup, which has ${markup.length} characters.`);
  }
  // A slice never splits a character made of two UTF-16 units: its start moves
  // back onto the character's first unit, and its end past the second.
  const from = safeCut(markup, start);
  const to = length === undefined ? markup.length : Math.min(markup.length, from + length);
  return { start: from, end: safeCut(markup, to) === to ? to : to + 1 };
}

/** `get`: the page as saved, its sources' last reads, and its markup to edit. */
function describePage(view: WorkspaceArtifactView, input: ArtifactToolInput): string {
  const { artifact, snapshot } = view;
  const lines = [`Artifact ${JSON.stringify(artifact.visual.title)} (id ${artifact.id}, revision ${artifact.revision}).`];
  if (artifact.description) lines.push(`Description: ${artifact.description}`);
  if (artifact.visual.layout === "wide") lines.push("Layout: wide");
  const { onOpen, intervalSeconds } = artifact.refresh;
  lines.push(`Refresh: ${onOpen ? "when shown" : "not when shown"}${intervalSeconds ? `, every ${intervalSeconds} seconds while visible` : ""}.`);
  if (artifact.sources.length) {
    lines.push("Sources:");
    for (const source of artifact.sources) {
      const what = source.kind === "shell" ? `shell \`${source.command}\`` : `file ${source.file}`;
      lines.push(`- ${source.name}: ${what}, parse ${source.parse}`);
      const result = snapshot?.sources[source.name];
      if (!result) {
        lines.push("  not read yet");
        continue;
      }
      const when = new Date(result.at).toISOString();
      lines.push(
        result.status === "ok"
          ? `  last read ${when}: ok`
          : `  last read ${when}: ${result.status === "blocked" ? "not run" : "failed"}: ${result.error ?? "unknown error"}`,
      );
      if (isStale(result)) lines.push("  the page still shows the data of an earlier read (stale)");
      const data = describeSourceData(result.dataJson);
      if (data) lines.push(`  shape: ${data.shape}`, `  sample: ${data.sample}`);
    }
  }
  if (artifact.actions.length) {
    lines.push("Actions:");
    for (const action of artifact.actions) {
      const problem = workspaceArtifactActionProblem(action);
      lines.push(`- ${action.name} (${JSON.stringify(action.label)}): ${action.command}${problem ? ` [turned off: ${problem}]` : ""}`);
    }
  }
  if (artifact.markup === undefined) {
    lines.push(noMarkupReason(artifact));
  } else {
    const { start, end } = markupSlice(input, artifact.markup);
    const whole = start === 0 && end === artifact.markup.length;
    lines.push(
      whole
        ? `Markup (${artifact.markup.length} characters):`
        : `Markup (characters ${start}–${end} of ${artifact.markup.length}${end < artifact.markup.length ? `; read on with offset ${end}` : ""}):`,
      artifact.markup.slice(start, end),
    );
  }
  return lines.join("\n");
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
        ...(snapshot?.sources[source.name]?.status !== "ok" && snapshot?.sources[source.name]?.error
          ? { lastError: snapshot.sources[source.name]!.error }
          : {}),
        ...(isStale(snapshot?.sources[source.name]) ? { stale: true } : {}),
      })),
      actions: artifact.actions.map((action) => {
        const problem = workspaceArtifactActionProblem(action);
        return {
          name: action.name,
          label: action.label,
          command: action.command,
          params: action.params,
          // Saved before a rule tightened: kept on the page, but it never runs until rewritten.
          ...(problem ? { disabled: `Turned off; run refuses it until you update the page's actions: ${problem}` } : {}),
        };
      }),
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
   * The revision each page was left at by this tool's own saves. One tool
   * serves one agent turn, so a later save in the turn folds into the first:
   * the page's history keeps the version from before the turn (for a page
   * made this turn, its first draft), one undo step. The title is the name
   * that save left: a page renamed since (by the person, or in another chat)
   * ends the fold, so the renamed version is kept as its own undo step.
   */
  const savedThisTurn = new Map<string, TurnSaves>();
  /**
   * After a save: the first refresh, then the page checked against its data.
   * The page is already saved, so neither may make the save look failed.
   */
  async function afterSave(
    artifact: WorkspaceArtifactV1,
    signal: AbortSignal | undefined,
    replaced?: WorkspaceArtifactV1,
  ): Promise<string> {
    let firstRefresh = "";
    let results: Record<string, WorkspaceArtifactSourceResultV1> | undefined;
    if (options.refresh && artifact.sources.length > 0) {
      try {
        const started = Date.now();
        results = await options.refresh(artifact, signal, replaced);
        firstRefresh = describeSources(results, "First refresh", started);
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

  /**
   * `check`: runs the sources a save would keep, once, and draws the page
   * against what they return. Nothing is saved, and the page's last data is
   * left as it was.
   */
  async function checkPage(input: ArtifactToolInput, shownDigest: string | undefined, signal: AbortSignal | undefined) {
    const previous = input.id === undefined ? undefined : (await options.store.get(options.workspaceId, idOf(input)))?.artifact;
    if (input.id !== undefined && !previous) throw new Error("No artifact with that id exists in this workspace.");
    if (!options.check) throw new Error("This chat cannot check artifact sources.");
    const target = checkTarget(input, previous, options);
    if (signal?.aborted) throw new Error("The check was cancelled.");
    // The same rule as a save: shell commands run once the person allowed
    // them, for this page or on this check's card.
    const approved =
      checkPageApproved(target.sources, previous) ||
      (shownDigest !== undefined && shownDigest === checkApprovalDigest(target.sources));
    const results = target.sources.length ? await options.check(target.sources, approved, signal) : {};
    let pageCheck = "";
    if (target.page) {
      try {
        pageCheck = describeWorkspaceArtifactPageCheck(checkWorkspaceArtifactPage(target.page, results));
      } catch {
        pageCheck = "\nPage check unavailable.";
      }
    }
    const what = previous ? `the artifact ${JSON.stringify(previous.visual.title)}` : "these sources";
    return `Checked ${what}; nothing was saved.${describeSources(results, "Sources")}${pageCheck}${describeDiagnostics(target.diagnostics)}`;
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

  return declareOnDemandSummary(
    declarePiRuntimeReplay(
    {
      name: WORKSPACE_ARTIFACT_TOOL_NAME,
      label: "Artifact",
      description:
        "Keep an interactive page in this workspace's Artifacts tab (beside the chat), for status the person will come back to: open pull requests, a release checklist, a TODO board. Unlike a visual in the reply, the page persists for every chat in the workspace and re-reads live data from named sources (a shell command or a workspace file, bound in markup as $name) each time it refreshes. Always list first and update an existing artifact instead of creating a near-duplicate. Delete only when the person asks. run performs one of a page's actions exactly as its button would; use it only when the person asks for that action. restore brings back one of the page's earlierRevisions (from list) as a new revision, keeping its current title; use it when the person wants to undo or go back to an earlier version. get returns a page's saved markup, its sources' last reads (status, error, data shape and a sample) and its revision; read it before changing a page, then prefer edits (exact old→new replacements) to resending the whole markup, and pass its revision as baseVersion. check runs a page's sources (or, with no id, the sources given) once and checks the markup against their data without saving anything, under the same approval as a save. Read the aiden-artifacts skill before the first call.",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("create"),
          Type.Literal("update"),
          Type.Literal("list"),
          Type.Literal("get"),
          Type.Literal("check"),
          Type.Literal("delete"),
          Type.Literal("run"),
          Type.Literal("restore"),
        ]),
        id: Type.Optional(Type.String({ description: "The artifact id from list; required for update, get, delete, run and restore." })),
        offset: Type.Optional(
          Type.Integer({ description: "get: the first character of the markup to show (default 0).", minimum: 0 }),
        ),
        length: Type.Optional(
          Type.Integer({ description: "get: how many characters of the markup to show (default all).", minimum: 1 }),
        ),
        revision: Type.Optional(
          Type.Integer({ description: "restore: one of the page's earlierRevisions from list.", minimum: 1 }),
        ),
        baseVersion: Type.Optional(
          Type.Integer({
            description:
              "update: the revision you read the page at (from get or list). If the page has changed since, in another chat or by the person, nothing is saved and the error says what changed and the current revision.",
            minimum: 1,
          }),
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
              "Aiden UI Markup for the page (the catalog visualize_guide lists), starting with <Visual title=\"…\">. Source data binds as $name; a source that has not loaded yet is null. Buttons may call run(\"actionName\", value…) and compose(\"text\") as well as sendPrompt, openUrl, copy and setState. Required for create; omit on update to keep the page, or send edits instead to change part of it.",
          }),
        ),
        edits: Type.Optional(
          Type.Array(
            Type.Object({
              old: Type.String({ description: "Exact text from the saved markup (from get), matching one place only.", minLength: 1 }),
              new: Type.String({ description: "The text to put in its place; \"\" removes it." }),
            }),
            {
              description:
                "update or check, instead of markup: replacements applied in order to the page's saved markup. All or nothing: if any old text is missing or matches more than one place, nothing is saved and the error names that edit. The edited page is checked like a full save.",
              minItems: 1,
              maxItems: MAX_MARKUP_EDITS,
            },
          ),
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
              command: Type.String({ description: "Command template; each {{param}}, an unquoted word alone or joined only to plain text (HEAD:{{file}}), becomes the value as one literal argument. With a {{param}} it runs without a shell (only quotes, | && || ; and 2>&1, >/dev/null, 2>/dev/null), and every command must start with an allowed program (git, gh pr/issue/run/repo/release/label/workflow verbs, or text tools such as grep, jq, sort). A {{param}} may sit only in a slot that program's table lists (an option value such as -m, -e, --title, --body, --search or --limit, or a text, file, branch, revision or number operand); other positions are refused with the allowed forms named, and an option the table does not list is refused with the options it does list (remove it; the rest still works). git diff, log and show -U/--unified, git log --pretty/--format, git pull -j and grep --context take a value only joined, so page data cannot fill them: write a fixed -U5 or --pretty=oneline, or grep -C {{n}}. git branch --list/-l and git tag -l take a text pattern; git stash show/apply/pop/drop also take stash@{n}. gh repo view/list take no {{param}} operand and --search refuses repo:, org:, user: and owner:. git runs with GIT_LITERAL_PATHSPECS=1 (a file value's * ? [ are part of its name; no :), a checkout, tag, cherry-pick or revert revision gets -- after it (and its options) when the template has none, a log, show or reset operand gets one only when its value is not also a file in the workspace (write {{rev}} -- for a revision and -- {{file}} for a file: without them a branch named like a folder is ambiguous and a deleted file is an unknown revision; in git log or show write options, with their values, before that value, since git reads none after a file), and git show HEAD:{{file}} runs as HEAD:./file (:0:{{file}} as :0:./file; write the stage literally), read from the workspace." }),
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
        if (operation === "get") {
          const view = await store.get(workspaceId, idOf(input));
          if (!view) throw new Error("No artifact with that id exists in this workspace.");
          return text(describePage(view, input));
        }
        if (operation === "check") return text(await checkPage(input, shownDigest, signal));
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
          // A restore is the person going back on purpose: what it replaced is kept,
          // and the next save starts a new undo step.
          savedThisTurn.delete(id);
          options.onChanged({ workspaceId, artifactId: artifact.id, reason: "updated", chatId });
          return text(
            `Restored revision ${revision} of the artifact "${artifact.visual.title}" as revision ${artifact.revision}.${await afterSave(artifact, signal, current.artifact)}`,
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
        const baseVersion = baseVersionOf(input, operation);
        const previous = operation === "update" ? (await store.get(workspaceId, idOf(input)))?.artifact : undefined;
        if (operation === "update" && !previous) throw new Error("No artifact with that id exists in this workspace.");
        const earlier = previous ? savedThisTurn.get(previous.id) : undefined;
        const earlierVersion = (revision: number) => store.revision(workspaceId, idOf(input), revision);
        if (previous && baseVersion !== undefined && !baseVersionHolds(baseVersion, previous, earlier)) {
          throw new Error(await baseVersionRefusal(baseVersion, previous, earlierVersion));
        }
        const renamedSince = earlier !== undefined && previous !== undefined && previous.visual.title !== earlier.title;
        // Repeating the name this turn's save gave keeps a rename made since.
        const requested = renamedSince && input.title === earlier.title ? { ...input, title: undefined } : input;
        const effective = withEdits(requested, previous);
        const built = contentFor(effective, previous);
        const { content } = built;
        let { diagnostics } = built;
        // Another chat's save or a rename landing from here until the write is
        // kept: the store settles the title and description against `base`
        // (a rename also ends this turn's fold), and every other value this
        // call left out is taken again from the page under the store's lock.
        assertSourcesRunnable(content, options);
        if (signal?.aborted) throw new Error("The artifact change was cancelled.");
        // The store approves only when the allowed card listed exactly the saved
        // commands; otherwise an unchanged set keeps the approval it already had.
        let replaced: WorkspaceArtifactV1 | undefined;
        let artifact: WorkspaceArtifactV1;
        try {
          artifact = previous
            ? await store.replace(
                workspaceId,
                previous.id,
                (current) => {
                  // Checked again under the lock: a save that landed since the read refuses this one.
                  if (baseVersion !== undefined && !baseVersionHolds(baseVersion, current, earlier)) {
                    throw new BaseVersionMoved(current);
                  }
                  replaced = current;
                  if (requested.edits === undefined || current.markup === previous.markup) {
                    return rebasedContent(effective, content, current);
                  }
                  // Another chat changed the markup since it was read: the edits
                  // apply to the markup saved now, or the save fails with the miss.
                  const redone = withEdits(requested, current);
                  const rebuilt = contentFor(redone, current);
                  diagnostics = rebuilt.diagnostics;
                  return rebasedContent(redone, rebuilt.content, current);
                },
                {
                  approvedDigest: shownDigest,
                  base: {
                    title: previous.visual.title,
                    ...(previous.description ? { description: previous.description } : {}),
                  },
                  ...(earlier ? { fold: { revision: earlier.revision, title: earlier.title } } : {}),
                },
              )
            : await store.create(workspaceId, content, { approvedDigest: shownDigest, chatId });
        } catch (error) {
          if (error instanceof BaseVersionMoved && baseVersion !== undefined) {
            throw new Error(await baseVersionRefusal(baseVersion, error.current, earlierVersion));
          }
          throw error;
        }
        if (previous && artifact.revision === previous.revision) {
          if (artifact.approvedDigest !== previous.approvedDigest) {
            options.onChanged({ workspaceId, artifactId: artifact.id, reason: "updated", chatId });
          }
          return text(
            `Nothing changed: the artifact "${artifact.visual.title}" (id ${artifact.id}) already has exactly this page, data and actions, so no new revision was made.${describeDiagnostics(diagnostics)}`,
          );
        }
        // A page made in this turn keeps its first draft as the one undo step.
        if (previous) {
          // The turn's saves run on from where they began, unless another save came between.
          const from =
            earlier && replaced?.revision === earlier.revision ? earlier.from : (replaced?.revision ?? previous.revision);
          savedThisTurn.set(artifact.id, { from, revision: artifact.revision, title: artifact.visual.title });
        }
        options.onChanged({ workspaceId, artifactId: artifact.id, reason: previous ? "updated" : "created", chatId });
        const verb = previous ? "Updated" : "Created";
        return text(
          `${verb} the artifact "${artifact.visual.title}" (id ${artifact.id}, revision ${artifact.revision}). It is shown in this workspace's Artifacts tab.${await afterSave(artifact, signal, replaced)}${describeDiagnostics(diagnostics)}`,
        );
      },
    },
    "never",
    ),
    "Keep a live page in this workspace's Artifacts tab; use when the person wants something to come back to, like a pull request board or checklist.",
  );
}
