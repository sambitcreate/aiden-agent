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
import type {
  DesignCommentSourceIdentityV1,
  DesignCommentTargetV1,
} from "./design-comment-contract.js";
import {
  computeDesignSourceManifestHash,
  resolveDesignSourceSelection,
  type DesignSourceManifestV1,
  type DesignSourceRangeV1,
} from "./design-source-graph-core.js";

const MAX_SOURCE_BYTES = 192 * 1024;
const BINDING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIONS = 80;
const DETERMINISTIC_ACTION_ID = /^action_[a-f0-9]{64}$/u;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const SOURCE_SEARCH_SKIP = new Set([".git", ".next", "build", "dist", "node_modules"]);
const MAX_SOURCE_SEARCH_ENTRIES = 5_000;

export interface ResolvedSourceSelection extends SourceSelectionBindingV1 {
  ownerDocumentId: string;
  root: string;
  source: string;
  createdAt: number;
  componentName?: string;
  selectorMatchCount?: number;
  sourceManifestHash?: string;
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
  preApplyGuard?: () => Promise<boolean>;
}

interface SourceGraphUse {
  owner?: string;
  repeated: boolean;
  source: DesignSourceRangeV1;
}

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9_$]{0,159}$/u;

function enclosingComponentName(node: ts.Node | undefined): string | undefined {
  for (let current = node?.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return undefined;
}

function isRepeatedJsxUse(node: ts.Node): boolean {
  const owner = enclosingComponentName(node);
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return true;
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ["map", "flatMap", "forEach"].includes(current.expression.name.text)
    ) {
      return true;
    }
    if (owner && enclosingComponentName(current) !== owner) break;
  }
  return false;
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
  else if (/^https?:\/\//u.test(value)) value = new URL(value).pathname;
  if (value.startsWith("/@fs/")) value = value.slice(4);
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

async function existingSourcePath(root: string, supplied: string): Promise<string> {
  const direct = normalizeReportedPath(root, supplied);
  if (insideRoot(root, direct) && SOURCE_EXTENSIONS.has(path.extname(direct).toLowerCase())) {
    try {
      if ((await fs.stat(direct)).isFile()) return direct;
    } catch {
      // Sourcemaps may report a package-relative basename rather than a root-relative path.
    }
  }
  let suffix = supplied.trim();
  try {
    if (/^(?:file|https?):\/\//u.test(suffix)) suffix = new URL(suffix).pathname;
  } catch {
    throw new Error("The selected source path is invalid.");
  }
  suffix =
    suffix
      .split(/[?#]/u, 1)[0]
      ?.replace(/^\/@fs\//u, "/")
      .replace(/^\/+|^\.\//gu, "") ?? "";
  if (!suffix || !SOURCE_EXTENSIONS.has(path.extname(suffix).toLowerCase())) {
    throw new Error("The selected element does not map to a supported workspace source file.");
  }
  const portableSuffix = suffix.split(path.sep).join("/");
  const matches: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_SOURCE_SEARCH_ENTRIES && matches.length < 2) {
    const directory = queue.shift();
    if (!directory) break;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_SOURCE_SEARCH_ENTRIES) break;
      if (entry.isDirectory()) {
        if (!SOURCE_SEARCH_SKIP.has(entry.name)) queue.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        continue;
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      if (relative === portableSuffix || relative.endsWith(`/${portableSuffix}`)) {
        matches.push(candidate);
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length > 1
        ? "The selected source mapping is ambiguous. Select a different exact element."
        : "The selected source file is unavailable.",
    );
  }
  return matches[0]!;
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
  descriptor: SourceElementDescriptorV1,
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
  const candidates: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  let best: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      candidates.push(node);
      if (
        position >= node.getFullStart() &&
        position <= node.getEnd() &&
        (!best || node.getWidth(sourceFile) < best.getWidth(sourceFile))
      ) {
        best = node;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const tagName = (node: ts.JsxElement | ts.JsxSelfClosingElement): string =>
    (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText(sourceFile);
  if (best && tagName(best) === descriptor.selection.tagName) {
    return { start: best.getStart(sourceFile), end: best.getEnd() };
  }

  const stableAttribute = (() => {
    if (descriptor.selection.elementId) {
      return { name: "id", value: descriptor.selection.elementId };
    }
    const match = descriptor.selection.selector.match(
      /^\[(data-testid|data-aiden-id)="([A-Za-z0-9._:-]{1,120})"\]$/u,
    );
    return match?.[1] && match[2] ? { name: match[1], value: match[2] } : undefined;
  })();
  if (!stableAttribute) return undefined;
  const matching = candidates.filter((node) => {
    if (tagName(node) !== descriptor.selection.tagName) return false;
    const attributes = ts.isJsxElement(node)
      ? node.openingElement.attributes.properties
      : node.attributes.properties;
    return attributes.some((attribute) => {
      if (
        !ts.isJsxAttribute(attribute) ||
        attribute.name.getText(sourceFile) !== stableAttribute.name
      ) {
        return false;
      }
      return (
        attribute.initializer !== undefined &&
        ts.isStringLiteral(attribute.initializer) &&
        attribute.initializer.text === stableAttribute.value
      );
    });
  });
  const exact = matching.length === 1 ? matching[0] : undefined;
  return exact ? { start: exact.getStart(sourceFile), end: exact.getEnd() } : undefined;
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
    projectId: string,
    workspaceId: string,
    sessionId: string,
    descriptor: SourceElementDescriptorV1,
  ): Promise<SourceSelectionBindingV1> {
    this.prune();
    const authority = sourceDesignPreviewService.authority(
      owner.documentId,
      projectId,
      workspaceId,
      sessionId,
    );
    if (!authority) throw new Error("The local preview session is no longer active.");
    if (!descriptor.filePath || !descriptor.lineNumber || !descriptor.columnNumber) {
      throw new Error("React source metadata is unavailable for that exact element.");
    }
    const root = await fs.realpath(authority.root);
    const reported = await existingSourcePath(root, descriptor.filePath);
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
      descriptor,
    );
    if (!range) throw new Error("Aiden could not bind that exact element to a JSX range.");
    const relative = path.relative(root, canonicalPath).split(path.sep).join("/");
    const id = `selection_${randomUUID().replace(/-/gu, "")}`;
    const binding: ResolvedSourceSelection = {
      version: SOURCE_DESIGNER_VERSION,
      id,
      projectId,
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
      ...(descriptor.componentName ? { componentName: descriptor.componentName } : {}),
      ...(descriptor.selectorMatchCount
        ? { selectorMatchCount: descriptor.selectorMatchCount }
        : {}),
    };
    const graphProof = await this.connectedSourceGraphProof(binding);
    if (!graphProof) {
      throw new Error(
        "Aiden could not prove one exact runtime/source instance for that selection.",
      );
    }
    binding.sourceManifestHash = graphProof.manifestHash;
    this.bindings.set(id, binding);
    const {
      ownerDocumentId: _owner,
      root: _root,
      source: _source,
      createdAt: _created,
      componentName: _componentName,
      selectorMatchCount: _selectorMatchCount,
      sourceManifestHash: _sourceManifestHash,
      ...view
    } = binding;
    return view;
  }

  /**
   * Conservatively prove that the selected JSX definition belongs to one
   * component instance. The preview must report one live selector match, and
   * every component owner up to a root/default route must have exactly one
   * non-looped JSX use across the authorized workspace. Ambiguity fails closed.
   */
  private async connectedSourceGraphProof(
    binding: ResolvedSourceSelection,
    sourceOverrides?: ReadonlyMap<string, string>,
  ): Promise<{ manifestHash: string } | undefined> {
    if (
      binding.selectorMatchCount !== 1 ||
      !binding.componentName ||
      !COMPONENT_NAME.test(binding.componentName)
    ) {
      return undefined;
    }
    const queue = [binding.root];
    const documents: Array<{ relative: string; sourceFile: ts.SourceFile }> = [];
    let visited = 0;
    while (queue.length > 0 && visited < MAX_SOURCE_SEARCH_ENTRIES) {
      const directory = queue.shift();
      if (!directory) break;
      let entries: Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return undefined;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_SOURCE_SEARCH_ENTRIES) return undefined;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SOURCE_SEARCH_SKIP.has(entry.name)) queue.push(candidate);
          continue;
        }
        if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        let stat: Awaited<ReturnType<typeof fs.stat>>;
        let source: string;
        try {
          stat = await fs.stat(candidate);
          if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return undefined;
          const relative = path.relative(binding.root, candidate).split(path.sep).join("/");
          source = sourceOverrides?.get(relative) ?? (await fs.readFile(candidate, "utf8"));
          if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return undefined;
          documents.push({
            relative,
            sourceFile: ts.createSourceFile(
              candidate,
              source,
              ts.ScriptTarget.Latest,
              true,
              scriptKind(candidate),
            ),
          });
        } catch {
          return undefined;
        }
      }
    }

    const definitions = new Map<string, DesignSourceRangeV1[]>();
    const uses = new Map<string, SourceGraphUse[]>();
    const defaultRoots = new Set<string>();
    let selectedOwner: string | undefined;
    for (const document of documents) {
      const { sourceFile } = document;
      const sourceRange = (node: ts.Node): DesignSourceRangeV1 => {
        const start = node.getStart(sourceFile);
        const end = node.getEnd();
        const position = sourceFile.getLineAndCharacterOfPosition(start);
        return {
          workspaceRelativePath: document.relative,
          sourceVersion: contentVersion(sourceFile.text),
          start,
          end,
          line: position.line + 1,
          column: position.character + 1,
        };
      };
      const addDefinition = (name: string, node: ts.Node): void => {
        if (!COMPONENT_NAME.test(name)) return;
        const current = definitions.get(name) ?? [];
        current.push(sourceRange(node));
        definitions.set(name, current);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          addDefinition(node.name.text, node);
          if (
            node.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword) &&
            node.modifiers.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
          ) {
            defaultRoots.add(node.name.text);
          }
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        ) {
          addDefinition(node.name.text, node);
        } else if (
          ts.isExportAssignment(node) &&
          !node.isExportEquals &&
          ts.isIdentifier(node.expression)
        ) {
          defaultRoots.add(node.expression.text);
        }
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
          const opening = ts.isJsxElement(node) ? node.openingElement : node;
          const tagName = opening.tagName.getText(sourceFile);
          if (COMPONENT_NAME.test(tagName)) {
            const current = uses.get(tagName) ?? [];
            current.push({
              ...(enclosingComponentName(node) ? { owner: enclosingComponentName(node) } : {}),
              repeated: isRepeatedJsxUse(node),
              source: sourceRange(node),
            });
            uses.set(tagName, current);
          }
          if (
            document.relative === binding.path &&
            node.getStart(sourceFile) === binding.start &&
            node.getEnd() === binding.end
          ) {
            selectedOwner = enclosingComponentName(node);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    if (selectedOwner !== binding.componentName) return undefined;

    const seen = new Set<string>();
    const componentChain: string[] = [];
    let current: string | undefined = binding.componentName;
    while (current) {
      if (seen.has(current) || definitions.get(current)?.length !== 1) return undefined;
      seen.add(current);
      componentChain.push(current);
      const componentUses: SourceGraphUse[] = uses.get(current) ?? [];
      if (componentUses.length === 0) {
        if (!defaultRoots.has(current)) return undefined;
        current = undefined;
        break;
      }
      if (componentUses.length !== 1 || componentUses[0]!.repeated) return undefined;
      current = componentUses[0]!.owner;
    }
    const componentId = `intrinsic_${binding.selection.tagName}`;
    const runtimeInstanceId = `runtime_${createHash("sha256")
      .update(`${binding.id}\0${binding.selection.selector}`)
      .digest("hex")
      .slice(0, 40)}`;
    const manifestBody = {
      version: 1 as const,
      id: `manifest_${createHash("sha256").update(binding.id).digest("hex").slice(0, 40)}`,
      revision: 1,
      workspaceId: binding.workspaceId,
      components: [
        { id: componentId, displayName: binding.selection.tagName, kind: "intrinsic" as const },
        ...componentChain.map((name) => ({
          id: `component_${name}`,
          displayName: name,
          kind: "custom" as const,
          definition: definitions.get(name)![0]!,
        })),
      ],
      instances: [
        {
          runtimeInstanceId,
          selector: binding.selection.selector,
          componentId,
          source: {
            workspaceRelativePath: binding.path,
            sourceVersion: binding.sourceVersion,
            start: binding.start,
            end: binding.end,
            line: binding.lineNumber,
            column: binding.columnNumber,
          },
          ...(componentChain[0]
            ? {
                parentRuntimeInstanceId: `runtime_component_${createHash("sha256")
                  .update(`${binding.id}\0${componentChain[0]}`)
                  .digest("hex")
                  .slice(0, 32)}`,
              }
            : {}),
        },
        ...componentChain.map((name, index) => {
          const use = uses.get(name)?.[0];
          const source = use?.source ?? definitions.get(name)![0]!;
          return {
            runtimeInstanceId: `runtime_component_${createHash("sha256")
              .update(`${binding.id}\0${name}`)
              .digest("hex")
              .slice(0, 32)}`,
            selector: `[data-aiden-component="${name}"]`,
            componentId: `component_${name}`,
            source,
            ...(componentChain[index + 1]
              ? {
                  parentRuntimeInstanceId: `runtime_component_${createHash("sha256")
                    .update(`${binding.id}\0${componentChain[index + 1]}`)
                    .digest("hex")
                    .slice(0, 32)}`,
                }
              : {}),
          };
        }),
      ],
    };
    const manifest: DesignSourceManifestV1 = {
      ...manifestBody,
      manifestHash: computeDesignSourceManifestHash(manifestBody),
    };
    const currentSourceVersions = Object.fromEntries(
      documents.map(({ relative, sourceFile }) => [relative, contentVersion(sourceFile.text)]),
    );
    const resolution = resolveDesignSourceSelection({
      manifest,
      request: {
        version: 1,
        manifestHash: manifest.manifestHash,
        runtimeInstanceId,
        selector: binding.selection.selector,
        componentId,
        scope: "runtime-instance",
      },
      currentSourceVersions,
    });
    return resolution.status === "resolved" ? { manifestHash: manifest.manifestHash } : undefined;
  }

  async proveConnectedComponentSingleUse(binding: ResolvedSourceSelection): Promise<boolean> {
    const proof = await this.connectedSourceGraphProof(binding);
    return Boolean(
      proof && (!binding.sourceManifestHash || binding.sourceManifestHash === proof.manifestHash),
    );
  }

  async connectedComponentManifestHash(
    binding: ResolvedSourceSelection,
  ): Promise<string | undefined> {
    return (await this.connectedSourceGraphProof(binding))?.manifestHash;
  }

  async connectedComponentPostimageProof(
    binding: ResolvedSourceSelection,
    source: string,
    sourcePostimages?: ReadonlyMap<string, string>,
  ): Promise<
    | {
        manifestHash: string;
        sourceVersion: string;
        start: number;
        end: number;
        lineNumber: number;
        columnNumber: number;
      }
    | undefined
  > {
    const range = exactJsxRange(source, binding.path, binding.lineNumber, binding.columnNumber, {
      version: SOURCE_DESIGNER_VERSION,
      selection: binding.selection,
      filePath: binding.path,
      lineNumber: binding.lineNumber,
      columnNumber: binding.columnNumber,
      ...(binding.componentName ? { componentName: binding.componentName } : {}),
      selectorMatchCount: 1,
    });
    if (!range) return undefined;
    const sourceFile = ts.createSourceFile(
      binding.path,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(binding.path),
    );
    const position = sourceFile.getLineAndCharacterOfPosition(range.start);
    const postimage: ResolvedSourceSelection = {
      ...binding,
      source,
      sourceVersion: contentVersion(source),
      start: range.start,
      end: range.end,
      lineNumber: position.line + 1,
      columnNumber: position.character + 1,
      snippet: source.slice(range.start, range.end),
    };
    delete postimage.sourceManifestHash;
    const sourceOverrides = new Map(sourcePostimages);
    sourceOverrides.set(binding.path, source);
    const proof = await this.connectedSourceGraphProof(postimage, sourceOverrides);
    return proof
      ? {
          manifestHash: proof.manifestHash,
          sourceVersion: postimage.sourceVersion,
          start: postimage.start,
          end: postimage.end,
          lineNumber: postimage.lineNumber,
          columnNumber: postimage.columnNumber,
        }
      : undefined;
  }

  async proveDurableConnectedComponentSingleUse(input: {
    selectionId: string;
    workspaceId: string;
    root: string;
    path: string;
    sourceVersion: string;
    source: string;
    start: number;
    end: number;
    lineNumber: number;
    columnNumber: number;
    componentName: string;
    selector: string;
    tagName: string;
    elementId?: string;
    manifestHash: string;
  }): Promise<boolean> {
    if (
      input.start < 0 ||
      input.end <= input.start ||
      input.end > input.source.length ||
      contentVersion(input.source) !== input.sourceVersion
    ) {
      return false;
    }
    const binding: ResolvedSourceSelection = {
      version: SOURCE_DESIGNER_VERSION,
      id: input.selectionId,
      projectId: "durable-authority-proof",
      sessionId: "durable-authority-proof",
      workspaceId: input.workspaceId,
      path: input.path,
      sourceVersion: input.sourceVersion,
      start: input.start,
      end: input.end,
      lineNumber: input.lineNumber,
      columnNumber: input.columnNumber,
      snippet: input.source.slice(input.start, input.end),
      selection: {
        version: 1,
        label: input.tagName,
        selector: input.selector,
        tagName: input.tagName,
        ...(input.elementId ? { elementId: input.elementId } : {}),
      },
      ownerDocumentId: "durable-authority-proof",
      root: input.root,
      source: input.source,
      createdAt: Date.now(),
      componentName: input.componentName,
      selectorMatchCount: 1,
      sourceManifestHash: input.manifestHash,
    };
    return this.proveConnectedComponentSingleUse(binding);
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
        binding.projectId,
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

  async proveConnectedCommentTarget(
    owner: ChatGenerationOwner,
    workspaceId: string,
    target: DesignCommentTargetV1 & {
      source: Extract<DesignCommentSourceIdentityV1, { kind: "connected-source" }>;
    },
  ): Promise<boolean> {
    this.prune();
    for (const binding of this.bindings.values()) {
      if (
        binding.ownerDocumentId !== owner.documentId ||
        binding.workspaceId !== workspaceId ||
        binding.path !== target.source.path ||
        binding.sourceVersion !== target.source.sourceVersion ||
        binding.start !== target.source.start ||
        binding.end !== target.source.end ||
        binding.selection.selector !== target.element.selector ||
        binding.selection.tagName !== target.element.tagName ||
        binding.selection.elementId !== target.element.elementId ||
        createHash("sha256").update(binding.snippet).digest("hex") !== target.source.preimageHash
      ) {
        continue;
      }
      try {
        await this.resolve(owner, workspaceId, binding.id);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Read a full, hash-pinned workspace document for the Design Code inspector.
   * This shares the exact live-preview authority and stale-snapshot proof used
   * by Designer Actions; it grants no write or command capability.
   */
  async readBoundSource(
    owner: ChatGenerationOwner,
    workspaceId: string,
    selectionId: string,
  ): Promise<{ path: string; content: string; sourceVersion: string }> {
    const binding = await this.resolve(owner, workspaceId, selectionId);
    return {
      path: binding.path,
      content: binding.source,
      sourceVersion: binding.sourceVersion,
    };
  }

  propose(input: {
    owner: ChatGenerationOwner;
    chatId: string;
    binding: ResolvedSourceSelection;
    label: string;
    replacement: string;
    /** Stable identity for renderer-retryable proposals promoted to a durable journal. */
    actionId?: string;
    preApplyGuard?: () => Promise<boolean>;
  }): DesignerActionV1 {
    if (!validJsxReplacement(input.replacement)) {
      throw new Error("The proposed replacement must be one valid, bounded JSX element.");
    }
    const nextSource =
      input.binding.source.slice(0, input.binding.start) +
      input.replacement +
      input.binding.source.slice(input.binding.end);
    if (input.actionId !== undefined && !DETERMINISTIC_ACTION_ID.test(input.actionId)) {
      throw new Error("Invalid deterministic Designer Action identity.");
    }
    const id = input.actionId ?? `action_${randomUUID().replace(/-/gu, "")}`;
    const label = boundedLabel(input.label);
    const existing = this.actions.get(id);
    if (existing) {
      const exactReplay =
        existing.ownerDocumentId === input.owner.documentId &&
        existing.view.status === "pending" &&
        existing.view.projectId === input.binding.projectId &&
        existing.view.chatId === input.chatId &&
        existing.view.workspaceId === input.binding.workspaceId &&
        existing.view.label === label &&
        existing.view.path === input.binding.path &&
        existing.view.selectionLabel === input.binding.selection.label &&
        existing.view.before === input.binding.snippet &&
        existing.view.after === input.replacement &&
        existing.root === input.binding.root &&
        existing.beforeVersion === input.binding.sourceVersion &&
        existing.originalSource === input.binding.source &&
        existing.nextSource === nextSource &&
        existing.start === input.binding.start &&
        existing.end === input.binding.end;
      if (!exactReplay) {
        throw new Error("Designer Action identity is already bound to another proposal.");
      }
      return { ...existing.view };
    }
    const view: DesignerActionV1 = {
      version: SOURCE_DESIGNER_VERSION,
      id,
      projectId: input.binding.projectId,
      chatId: input.chatId,
      workspaceId: input.binding.workspaceId,
      status: "pending",
      label,
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
      ...(input.preApplyGuard ? { preApplyGuard: input.preApplyGuard } : {}),
    };
    this.actions.set(id, action);
    this.prune();
    this.notify(action);
    return view;
  }

  list(
    owner: RendererDocumentOwner,
    projectId: string,
    chatId: string,
    workspaceId: string,
  ): DesignerActionV1[] {
    return [...this.actions.values()]
      .filter(
        (action) =>
          action.ownerDocumentId === owner.documentId &&
          action.view.projectId === projectId &&
          action.view.chatId === chatId &&
          action.view.workspaceId === workspaceId,
      )
      .map((action) => ({ ...action.view }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  /** Main-owned cascade inspection; action contents and source bytes stay private. */
  inspectChatActionIds(chatId: string): string[] {
    this.prune();
    return [...this.actions.values()]
      .filter(({ view }) => view.chatId === chatId)
      .map(({ view }) => view.id)
      .sort();
  }

  /**
   * Idempotently finish a captured Design Project cascade. An action that was
   * created after confirmation is not part of that authority and blocks the
   * older delete rather than being removed.
   */
  deleteChatActions(chatId: string, expectedIds: readonly string[]): number {
    this.prune();
    const expected = new Set(expectedIds);
    if (expected.size !== expectedIds.length) {
      throw new Error("Invalid Designer Action cascade.");
    }
    const current = [...this.actions.values()].filter(({ view }) => view.chatId === chatId);
    if (current.some(({ view }) => !expected.has(view.id))) {
      throw new Error("Designer Actions changed after deletion was confirmed.");
    }
    for (const action of current) this.actions.delete(action.view.id);
    return current.length;
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
      if (action.preApplyGuard && !(await action.preApplyGuard())) {
        throw new Error("The selected component instance changed before Apply.");
      }
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

  /** Remove an in-memory proposal after its exact bytes are durably journaled elsewhere. */
  discardForDurable(owner: RendererDocumentOwner, actionId: string): void {
    const action = this.actions.get(actionId);
    // A lost IPC response may replay after the first request already promoted
    // and discarded this transient proposal. The durable journal is the
    // authority at that point, so absence is the idempotent completed state.
    if (!action) return;
    if (
      action.ownerDocumentId !== owner.documentId ||
      action.view.status !== "pending"
    ) {
      throw new Error("That Designer Action cannot be promoted to durable review.");
    }
    this.actions.delete(actionId);
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
