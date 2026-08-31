import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import type { ChatGenerationOwner } from "./chat-generation-owner.js";
import type { RendererDocumentOwner } from "./renderer-document-owner.js";
import { sourceDesignPreviewService } from "./source-design-preview.js";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace-files.js";
import {
  MAX_DESIGNER_REPLACEMENT_BYTES,
  SOURCE_DESIGNER_VERSION,
  type DesignerActionV1,
  type SourceElementDescriptorV1,
  type SourceSelectionBindingV1,
} from "../../renderer/shared/source-designer.js";

const MAX_SOURCE_BYTES = 1_500_000;
const BINDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIONS = 80;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

export interface ResolvedSourceSelection extends SourceSelectionBindingV1 {
  ownerDocumentId: string;
  root: string;
  source: string;
  createdAt: number;
}

interface InternalAction {
  view: DesignerActionV1;
  ownerDocumentId: string;
  owner: ChatGenerationOwner;
  root: string;
  beforeVersion: string;
  afterVersion?: string;
  originalSource: string;
  nextSource: string;
  start: number;
  end: number;
}

interface SourceFileWithDiagnostics extends ts.SourceFile {
  parseDiagnostics: readonly ts.Diagnostic[];
}

function contentVersion(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeReportedPath(root: string, supplied: string): string {
  let value = supplied.trim().split(/[?#]/u, 1)[0] ?? "";
  if (value.startsWith("file://")) value = fileURLToPath(value);
  if (value.startsWith("/@fs/")) value = value.slice(4);
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function exactJsxRange(
  source: string,
  filePath: string,
  lineNumber: number,
  columnNumber: number,
): { start: number; end: number } | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const line = Math.max(0, lineNumber - 1);
  const column = Math.max(0, columnNumber - 1);
  if (line >= sourceFile.getLineStarts().length) return undefined;
  const position = sourceFile.getPositionOfLineAndCharacter(line, column);
  let best: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position > node.getEnd()) return;
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      if (!best || node.getWidth(sourceFile) < best.getWidth(sourceFile)) best = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best ? { start: best.getStart(sourceFile), end: best.getEnd() } : undefined;
}

function validJsxReplacement(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_DESIGNER_REPLACEMENT_BYTES ||
    value.includes("\0")
  ) {
    return false;
  }
  const source = ts.createSourceFile(
    "aiden-proposal.tsx",
    `const __aidenProposal = (${value});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ) as SourceFileWithDiagnostics;
  return source.parseDiagnostics.length === 0;
}

function boundedLabel(value: string): string {
  const label = value.replace(/\s+/gu, " ").trim();
  return (label || "Update selected element").slice(0, 160);
}

export class SourceDesignerActionService {
  private readonly bindings = new Map<string, ResolvedSourceSelection>();
  private readonly actions = new Map<string, InternalAction>();

  private prune(): void {
    const cutoff = Date.now() - BINDING_TTL_MS;
    for (const [id, binding] of this.bindings) {
      if (binding.createdAt < cutoff) this.bindings.delete(id);
    }
    while (this.actions.size > MAX_ACTIONS) {
      const oldest = this.actions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.actions.delete(oldest);
    }
  }

  async bind(
    owner: RendererDocumentOwner,
    workspaceId: string,
    sessionId: string,
    descriptor: SourceElementDescriptorV1,
  ): Promise<SourceSelectionBindingV1> {
    this.prune();
    const authority = sourceDesignPreviewService.authority(
      owner.documentId,
      workspaceId,
      sessionId,
    );
    if (!authority) throw new Error("The local preview session is no longer active.");
    if (!descriptor.filePath || !descriptor.lineNumber || !descriptor.columnNumber) {
      throw new Error("React source metadata is unavailable for that exact element.");
    }
    const root = await fs.realpath(authority.root);
    const reported = normalizeReportedPath(root, descriptor.filePath);
    if (!insideRoot(root, reported) || !SOURCE_EXTENSIONS.has(path.extname(reported).toLowerCase())) {
      throw new Error("The selected element does not map to a supported workspace source file.");
    }
    const canonicalPath = await fs.realpath(reported);
    if (!insideRoot(root, canonicalPath)) {
      throw new Error("The selected element resolves outside the workspace.");
    }
    const stat = await fs.stat(canonicalPath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
      throw new Error("The selected source file is unavailable or too large.");
    }
    const source = await fs.readFile(canonicalPath, "utf8");
    const range = exactJsxRange(
      source,
      canonicalPath,
      descriptor.lineNumber,
      descriptor.columnNumber,
    );
    if (!range) throw new Error("Aiden could not bind that exact element to a JSX range.");
    const relative = path.relative(root, canonicalPath).split(path.sep).join("/");
    const id = `selection_${randomUUID().replace(/-/gu, "")}`;
    const binding: ResolvedSourceSelection = {
      version: SOURCE_DESIGNER_VERSION,
      id,
      sessionId,
      workspaceId,
      path: relative,
      sourceVersion: contentVersion(source),
      start: range.start,
      end: range.end,
      lineNumber: descriptor.lineNumber,
      columnNumber: descriptor.columnNumber,
      snippet: source.slice(range.start, range.end),
      selection: descriptor.selection,
      ownerDocumentId: owner.documentId,
      root,
      source,
      createdAt: Date.now(),
    };
    this.bindings.set(id, binding);
    const { ownerDocumentId: _owner, root: _root, source: _source, createdAt: _created, ...view } =
      binding;
    return view;
  }

  async resolve(
    owner: ChatGenerationOwner,
    workspaceId: string,
    selectionId: string,
  ): Promise<ResolvedSourceSelection> {
    this.prune();
    const binding = this.bindings.get(selectionId);
    if (
      !binding ||
      binding.ownerDocumentId !== owner.documentId ||
      binding.workspaceId !== workspaceId ||
      !sourceDesignPreviewService.authority(
        owner.documentId,
        workspaceId,
        binding.sessionId,
      )
    ) {
      throw new Error("The selected source element is stale. Select it again and retry.");
    }
    const document = await readWorkspaceFile(binding.root, binding.path);
    if (
      document.version !== binding.sourceVersion ||
      document.content.slice(binding.start, binding.end) !== binding.snippet
    ) {
      throw new Error("The selected source changed. Select the element again before editing it.");
    }
    return binding;
  }

  propose(input: {
    owner: ChatGenerationOwner;
    chatId: string;
    binding: ResolvedSourceSelection;
    label: string;
    replacement: string;
  }): DesignerActionV1 {
    if (!validJsxReplacement(input.replacement)) {
      throw new Error("The proposed replacement must be one valid, bounded JSX element.");
    }
    const nextSource =
      input.binding.source.slice(0, input.binding.start) +
      input.replacement +
      input.binding.source.slice(input.binding.end);
    const id = `action_${randomUUID().replace(/-/gu, "")}`;
    const view: DesignerActionV1 = {
      version: SOURCE_DESIGNER_VERSION,
      id,
      chatId: input.chatId,
      workspaceId: input.binding.workspaceId,
      status: "pending",
      label: boundedLabel(input.label),
      path: input.binding.path,
      selectionLabel: input.binding.selection.label,
      before: input.binding.snippet,
      after: input.replacement,
      createdAt: Date.now(),
    };
    const action: InternalAction = {
      view,
      ownerDocumentId: input.owner.documentId,
      owner: input.owner,
      root: input.binding.root,
      beforeVersion: input.binding.sourceVersion,
      originalSource: input.binding.source,
      nextSource,
      start: input.binding.start,
      end: input.binding.end,
    };
    this.actions.set(id, action);
    this.prune();
    this.notify(action);
    return view;
  }

  list(owner: RendererDocumentOwner, chatId: string, workspaceId: string): DesignerActionV1[] {
    return [...this.actions.values()]
      .filter(
        (action) =>
          action.ownerDocumentId === owner.documentId &&
          action.view.chatId === chatId &&
          action.view.workspaceId === workspaceId,
      )
      .map((action) => ({ ...action.view }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async apply(
    owner: RendererDocumentOwner,
    actionId: string,
    root: string,
    signal: AbortSignal,
  ): Promise<DesignerActionV1> {
    const action = this.ownedAction(owner, actionId, root);
    if (action.view.status !== "pending") throw new Error("That action is no longer pending.");
    try {
      const saved = await writeWorkspaceFile(
        root,
        action.view.path,
        action.nextSource,
        action.beforeVersion,
        signal,
      );
      action.afterVersion = saved.version;
      action.view = { ...action.view, status: "applied", appliedAt: Date.now() };
    } catch (error) {
      action.view = {
        ...action.view,
        status: "stale",
        message: error instanceof Error ? error.message : "The source changed before apply.",
      };
    }
    this.notify(action);
    return { ...action.view };
  }

  reject(owner: RendererDocumentOwner, actionId: string): DesignerActionV1 {
    const action = this.actions.get(actionId);
    if (!action || action.ownerDocumentId !== owner.documentId) {
      throw new Error("That Designer Action is unavailable.");
    }
    if (action.view.status !== "pending") throw new Error("That action is no longer pending.");
    action.view = { ...action.view, status: "rejected" };
    this.notify(action);
    return { ...action.view };
  }

  async undo(
    owner: RendererDocumentOwner,
    actionId: string,
    root: string,
    signal: AbortSignal,
  ): Promise<DesignerActionV1> {
    const action = this.ownedAction(owner, actionId, root);
    if (action.view.status !== "applied" || !action.afterVersion) {
      throw new Error("That action cannot be undone.");
    }
    try {
      await writeWorkspaceFile(
        root,
        action.view.path,
        action.originalSource,
        action.afterVersion,
        signal,
      );
      action.view = { ...action.view, status: "undone" };
    } catch (error) {
      action.view = {
        ...action.view,
        status: "stale",
        message: error instanceof Error ? error.message : "The source changed before undo.",
      };
    }
    this.notify(action);
    return { ...action.view };
  }

  private ownedAction(
    owner: RendererDocumentOwner,
    actionId: string,
    root: string,
  ): InternalAction {
    const action = this.actions.get(actionId);
    if (
      !action ||
      action.ownerDocumentId !== owner.documentId ||
      path.resolve(action.root) !== path.resolve(root)
    ) {
      throw new Error("That Designer Action is unavailable.");
    }
    return action;
  }

  private notify(action: InternalAction): void {
    if (action.owner.isDestroyed()) return;
    action.owner.send("designer:action-changed", { action: { ...action.view } });
  }
}

export const sourceDesignerActionService = new SourceDesignerActionService();
