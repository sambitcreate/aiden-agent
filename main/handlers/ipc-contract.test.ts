// IPC contract guard: parse production TypeScript so the test inventory cannot
// drift away from the channels that main actually registers or broadcasts.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  INVOKE_PREFIXES,
  NATIVE_INVOKE_CHANNELS,
  NOTIFICATION_CHANNELS,
} from "../../renderer/preload-channels.js";
import {
  QUICK_CHAT_INVOKE_CHANNELS,
  QUICK_CHAT_NOTIFICATION_CHANNELS,
} from "../../renderer/quick-chat-preload-channels.js";
import {
  BOT_BUBBLES_INVOKE_CHANNELS,
  BOT_BUBBLES_NOTIFICATION_CHANNELS,
} from "../../renderer/bot-bubbles-preload-channels.js";
import {
  createAttachmentPreloadBridge,
  PRELOAD_MAX_ATTACHMENT_BYTES,
  PRELOAD_MAX_ATTACHMENT_PATHS,
  PRELOAD_MAX_CLIPBOARD_IMAGES,
  PRELOAD_MAX_IMAGE_BYTES,
} from "../../renderer/preload-attachments.js";
import {
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_CLIPBOARD_IMAGES,
  MAX_IMAGE_BYTES,
} from "../services/attachments.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";

interface IpcInventory {
  handlers: Set<string>;
  notifications: Set<string>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_ROOT = path.join(REPO_ROOT, "main");
const RENDERER_ROOT = path.join(REPO_ROOT, "renderer");
const PRELOAD_PATH = path.join(RENDERER_ROOT, "preload.ts");
const PRELOAD_ATTACHMENTS_PATH = path.join(RENDERER_ROOT, "preload-attachments.ts");
const RENDERER_IPC_PATH = path.join(RENDERER_ROOT, "lib", "ipc.ts");
const RENDERER_IPC_VOICE_PATH = path.join(RENDERER_ROOT, "lib", "ipc-voice.ts");
const RENDERER_BOT_PEERS_API_PATH = path.join(RENDERER_ROOT, "lib", "bot-peers-api.ts");
const ATTACHMENT_HANDLER_PATH = path.join(MAIN_ROOT, "handlers", "attachments.ts");

const HANDLER_BOOTSTRAP_PATH = path.join(MAIN_ROOT, "handlers", "index.ts");

/**
 * Explicit exemptions for desktop IPC client methods that intentionally have no
 * main-window production caller in `renderer/`. Every entry must map to a method
 * that currently exists in `renderer/` and carry an auditable reason.
 */
const DESKTOP_IPC_CALLER_ALLOWLIST: Readonly<Record<string, string>> = {
  "botsApi.issues.list":
    "Retained on main/handlers/bot-issues.ts; main window currently reads open issues via bots:live:summary.",
  "botsApi.routineModels.directory":
    "Retained on main/handlers/bot-routine-models.ts alongside read/catalog/save/readRuns.",
  "botsApi.rules.get":
    "Retained on main/handlers/bot-rules.ts for E2E fixtures while Settings uses approvalRulesApi.",
  "botsApi.rules.update":
    "Retained on main/handlers/bot-rules.ts for E2E fixtures while Settings uses approvalRulesApi.",
  "botsApi.sessionState":
    "bots:sessionState serves Bot bubbles overlay via botBubblesApi.sessionState while main window uses bots:live:subscribe.",
  "chatsApi.create":
    "chats:create is exercised directly by E2E specs while desktop flows call chatsApi.createWithFirstMessage.",
  "formFillApi.cancel":
    "Fail-closed form-fill artifact surface verified by main/services/computer-use/controller-form-fill.test.ts.",
  "formFillApi.download":
    "Fail-closed form-fill artifact surface verified by main/services/computer-use/controller-form-fill.test.ts.",
  "formFillApi.onProgress":
    "Fail-closed form-fill progress subscription retained alongside form-fill status/remove controls.",
  "formFillApi.setEnabled":
    "Fail-closed form-fill toggle verified by main/services/computer-use/controller-form-fill.test.ts.",
  "gitApi.restoreManagedWorktree":
    "Temporary exemption only while renderer/lib/ipc.ts still defines gitApi.restoreManagedWorktree before separate worktree-restore cleanup.",
  "peerHostsApi.operation":
    "Retained throwing RPC wrapper over remote:peerOperation alongside peerHostsApi.call.",
  "peerHostsApi.pair":
    "Retained direct payload pairing wrapper over remote:peersPair alongside pairRequest/pairSetupCode/pairLink.",
  "providersApi.listModels":
    "Retained on main/handlers/providers.ts alongside providersApi.test.",
  "skillsApi.discovered":
    "Staged skills:discovered discovery surface kept intact per IPC contract scope.",
  "workspacesApi.get":
    "workspaces:get is exercised directly by E2E specs while desktop flows read workspacesApi.list.",
};
function calleeName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function literalValue(
  expression: ts.Expression | undefined,
  channelConstants: ReadonlyMap<string, string>,
): string | undefined {
  if (!expression) return undefined;
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isIdentifier(expression)) return channelConstants.get(expression.text);
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return channelConstants.get(`${expression.expression.text}.${expression.name.text}`);
  }
  return undefined;
}

function unwrapConstAssertion(expression: ts.Expression): ts.Expression {
  return ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
    ? unwrapConstAssertion(expression.expression)
    : expression;
}

/** Resolve a channel template only when every interpolation has a literal, bounded loop domain. */
function channelValues(expression: ts.Expression | undefined, constants: ReadonlyMap<string, string>): string[] {
  const literal = literalValue(expression, constants);
  if (literal !== undefined) return [literal];
  if (!expression || !ts.isTemplateExpression(expression)) return [];
  let values = [expression.head.text];
  for (const span of expression.templateSpans) {
    let domain: string[] = [];
    if (ts.isIdentifier(span.expression)) {
      const name = span.expression.text;
      for (let parent: ts.Node | undefined = expression.parent; parent; parent = parent.parent) {
        if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue;
        const declaration = parent.initializer.declarations[0];
        if (!declaration || !ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const array = unwrapConstAssertion(parent.expression);
        if (ts.isArrayLiteralExpression(array) && array.elements.length <= 64 && array.elements.every(ts.isStringLiteralLike)) domain = array.elements.map((entry) => (entry as ts.StringLiteralLike).text);
        break;
      }
    }
    if (!domain.length || values.length * domain.length > 256) return [];
    values = values.flatMap((prefix) => domain.map((value) => prefix + value + span.literal.text));
  }
  return values;
}

function collectChannelConstants(sourceFiles: readonly ts.SourceFile[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith("_CHANNEL") &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        constants.set(node.name.text, node.initializer.text);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith("_CHANNELS") &&
        node.initializer
      ) {
        const table = unwrapConstAssertion(node.initializer);
        if (ts.isObjectLiteralExpression(table)) {
          for (const property of table.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
              ts.isStringLiteralLike(property.initializer)
            ) {
              constants.set(`${node.name.text}.${property.name.text}`, property.initializer.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return constants;
}

function collectInventory(
  sourceFiles: readonly ts.SourceFile[],
  constantSources: readonly ts.SourceFile[] = [],
): IpcInventory {
  const inventory: IpcInventory = {
    handlers: new Set(),
    notifications: new Set(),
  };
  const channelConstants = collectChannelConstants([...sourceFiles, ...constantSources]);

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name === "handle") {
          for (const channel of channelValues(node.arguments[0], channelConstants)) inventory.handlers.add(channel);
        } else if (name === "send" || name === "broadcast") {
          const channel = literalValue(node.arguments[0], channelConstants);
          if (channel) inventory.notifications.add(channel);
        } else if (name === "sendGeneration" || name === "safeSend") {
          const channel = literalValue(node.arguments[1], channelConstants);
          if (channel) inventory.notifications.add(channel);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return inventory;
}

/** Channels the renderer IPC client invokes: `invoke("channel", ...)` call sites. */
function collectRendererInvokes(
  sourceFiles: readonly ts.SourceFile[],
  constantSources: readonly ts.SourceFile[] = [],
): Set<string> {
  const channelConstants = collectChannelConstants([...sourceFiles, ...constantSources]);
  const invokes = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === "invoke") {
        for (const channel of channelValues(node.arguments[0], channelConstants)) invokes.add(channel);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return invokes;
}

async function productionSourceFiles(directory: string): Promise<ts.SourceFile[]> {
  const sourceFiles: ts.SourceFile[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "test-support") sourceFiles.push(...(await productionSourceFiles(target)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    const source = await fs.readFile(target, "utf-8");
    sourceFiles.push(
      ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    );
  }
  return sourceFiles;
}

/** The Bot bubble client and the overlay's own renderer (when present): they invoke `bots:bubbles:*`. */
async function botBubbleRendererSources(): Promise<ts.SourceFile[]> {
  const files = [path.join(REPO_ROOT, "renderer/lib/bot-bubbles-api.ts")];
  const overlayRoot = path.join(REPO_ROOT, "renderer", "bot-bubbles");
  const entries = await fs.readdir(overlayRoot, { recursive: true }).catch(() => [] as string[]);
  for (const entry of entries) {
    if (/\.tsx?$/u.test(entry) && !/\.test\.tsx?$/u.test(entry)) files.push(path.join(overlayRoot, entry));
  }
  return Promise.all(
    files.map(async (file) =>
      ts.createSourceFile(
        file,
        await fs.readFile(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    ),
  );
}

async function rendererProductionSourceFiles(directory: string): Promise<ts.SourceFile[]> {
  const sourceFiles: ts.SourceFile[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "test-support") {
        sourceFiles.push(...(await rendererProductionSourceFiles(target)));
      }
      continue;
    }
    if (
      !entry.isFile() ||
      !/\.tsx?$/u.test(entry.name) ||
      entry.name.endsWith(".d.ts") ||
      /\.test\.tsx?$/u.test(entry.name)
    ) {
      continue;
    }
    const source = await fs.readFile(target, "utf8");
    sourceFiles.push(
      ts.createSourceFile(
        target,
        source,
        ts.ScriptTarget.Latest,
        true,
        target.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    );
  }
  return sourceFiles;
}

interface DesktopIpcSources {
  ipc: ts.SourceFile;
  ipcVoice: ts.SourceFile;
  botPeersApi: ts.SourceFile;
  preload: ts.SourceFile;
  preloadAttachments: ts.SourceFile;
}

interface DesktopIpcMethodCatalog {
  methods: Set<string>;
  topLevelFunctions: Set<string>;
  internalDeps: Map<string, Set<string>>;
}

function unwrapValueExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return unwrapValueExpression(expression.expression);
  }
  return expression;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function hasTypeNodeAncestor(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

function extractReturnedObjectLiteral(fn: ts.FunctionDeclaration): ts.ObjectLiteralExpression | undefined {
  if (!fn.body) return undefined;
  for (const statement of fn.body.statements) {
    if (ts.isReturnStatement(statement) && statement.expression) {
      const unwrapped = unwrapValueExpression(statement.expression);
      if (ts.isObjectLiteralExpression(unwrapped)) return unwrapped;
    }
  }
  return undefined;
}

function collectLocalFunctionNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const init = unwrapValueExpression(declaration.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

function collectDesktopIpcMethods(sources: DesktopIpcSources): DesktopIpcMethodCatalog {
  const methods = new Set<string>();
  const topLevelFunctions = new Set<string>();
  const methodBodies = new Map<string, ts.Node>();
  const factories = new Map<string, { object: ts.ObjectLiteralExpression; localFns: Set<string> }>();

  for (const factorySource of [sources.botPeersApi, sources.preloadAttachments]) {
    const localFns = collectLocalFunctionNames(factorySource);
    for (const statement of factorySource.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
        const returned = extractReturnedObjectLiteral(statement);
        if (returned) factories.set(statement.name.text, { object: returned, localFns });
      }
    }
  }

  const collectObjectMethods = (
    prefix: string,
    objectLiteral: ts.ObjectLiteralExpression,
    localFns: ReadonlySet<string>,
  ): void => {
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const expr = unwrapValueExpression(property.expression);
        if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
          const factory = factories.get(expr.expression.text);
          if (factory) collectObjectMethods(prefix, factory.object, factory.localFns);
        }
        continue;
      }
      if (
        ts.isMethodDeclaration(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
      ) {
        const key = `${prefix}.${property.name.text}`;
        methods.add(key);
        methodBodies.set(key, property);
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      ) {
        continue;
      }
      const key = `${prefix}.${property.name.text}`;
      const init = unwrapValueExpression(property.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        collectObjectMethods(key, init, localFns);
      } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        methods.add(key);
        methodBodies.set(key, init);
      } else if (ts.isIdentifier(init) && localFns.has(init.text)) {
        methods.add(key);
        methodBodies.set(key, init);
      } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const factory = factories.get(init.expression.text);
        if (factory) collectObjectMethods(key, factory.object, factory.localFns);
      }
    }
  };

  for (const clientSource of [sources.ipc, sources.ipcVoice]) {
    const localFns = collectLocalFunctionNames(clientSource);
    for (const statement of clientSource.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
        methods.add(statement.name.text);
        topLevelFunctions.add(statement.name.text);
        methodBodies.set(statement.name.text, statement);
        continue;
      }
      if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const init = unwrapValueExpression(declaration.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          collectObjectMethods(declaration.name.text, init, localFns);
        }
      }
    }
  }

  const preloadLocalFns = collectLocalFunctionNames(sources.preload);
  for (const statement of sources.preload.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "aidenAPI" || !declaration.initializer) {
        continue;
      }
      const init = unwrapValueExpression(declaration.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        collectObjectMethods("aidenAPI", init, preloadLocalFns);
      }
    }
  }

  const internalDeps = new Map<string, Set<string>>();
  for (const [key, body] of methodBodies) {
    const deps = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node)) {
        const parts: string[] = [];
        let cursor: ts.Expression = node;
        while (ts.isPropertyAccessExpression(cursor)) {
          parts.unshift(cursor.name.text);
          cursor = unwrapValueExpression(cursor.expression);
        }
        if (ts.isIdentifier(cursor)) {
          parts.unshift(cursor.text);
          const normalized =
            (parts[0] === "window" || parts[0] === "globalThis") && parts[1] === "aidenAPI"
              ? parts.slice(1)
              : parts;
          const candidate = normalized.join(".");
          if (candidate !== key && methods.has(candidate)) deps.add(candidate);
        }
      } else if (ts.isIdentifier(node) && topLevelFunctions.has(node.text) && node.text !== key) {
        deps.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    if (deps.size > 0) internalDeps.set(key, deps);
  }

  return { methods, topLevelFunctions, internalDeps };
}

function isValueReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent || hasTypeNodeAncestor(node)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) {
    return false;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isJsxAttribute(parent)
  ) {
    return false;
  }
  return true;
}

function collectReachableDesktopIpcMethods(
  catalog: DesktopIpcMethodCatalog,
  callerFiles: readonly ts.SourceFile[],
): Set<string> {
  const { methods: definedMethods, topLevelFunctions, internalDeps } = catalog;
  const namespacePrefixes = new Set<string>();
  for (const method of definedMethods) {
    const parts = method.split(".");
    for (let i = 1; i < parts.length; i += 1) {
      namespacePrefixes.add(parts.slice(0, i).join("."));
    }
  }

  interface CallableTarget {
    file: ts.SourceFile;
    params: readonly ts.ParameterDeclaration[];
  }

  const fileMap = new Map<string, ts.SourceFile>();
  for (const sf of callerFiles) fileMap.set(sf.fileName, sf);

  const resolveModulePath = (fromFile: string, specifier: string): ts.SourceFile | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const stripped = specifier.replace(/\.(?:js|jsx|ts|tsx)$/u, "");
    const base = path.resolve(path.dirname(fromFile), stripped);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
      const match = fileMap.get(candidate);
      if (match) return match;
    }
    return undefined;
  };

  const exportedCallables = new Map<string, Map<string, CallableTarget>>();
  const localCallables = new Map<ts.SourceFile, Map<string, CallableTarget>>();
  const importedCallables = new Map<ts.SourceFile, Map<string, { targetFile: ts.SourceFile; exportName: string }>>();
  const aliasesByFile = new Map<ts.SourceFile, Map<string, string[]>>();
  const returnShapesByFile = new Map<ts.SourceFile, Map<string, Map<string, string[]>>>();

  for (const sf of callerFiles) {
    const exports = new Map<string, CallableTarget>();
    const locals = new Map<string, CallableTarget>();
    const imports = new Map<string, { targetFile: ts.SourceFile; exportName: string }>();
    aliasesByFile.set(sf, new Map());
    returnShapesByFile.set(sf, new Map());

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const targetFile = resolveModulePath(sf.fileName, statement.moduleSpecifier.text);
        const namedBindings = statement.importClause?.namedBindings;
        if (targetFile && namedBindings && ts.isNamedImports(namedBindings)) {
          for (const element of namedBindings.elements) {
            const exportName = element.propertyName ? element.propertyName.text : element.name.text;
            imports.set(element.name.text, { targetFile, exportName });
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const target: CallableTarget = { file: sf, params: statement.parameters };
        locals.set(statement.name.text, target);
        if (hasExportModifier(statement)) exports.set(statement.name.text, target);
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        const ctor = statement.members.find(ts.isConstructorDeclaration);
        if (ctor) {
          const target: CallableTarget = { file: sf, params: ctor.parameters };
          locals.set(statement.name.text, target);
          if (hasExportModifier(statement)) exports.set(statement.name.text, target);
        }
      } else if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          const init = unwrapValueExpression(declaration.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const target: CallableTarget = { file: sf, params: init.parameters };
            locals.set(declaration.name.text, target);
            if (exported) exports.set(declaration.name.text, target);
          }
        }
      }
    }

    exportedCallables.set(sf.fileName, exports);
    localCallables.set(sf, locals);
    importedCallables.set(sf, imports);
  }

  const resolveChain = (
    node: ts.Node,
    aliases: ReadonlyMap<string, string[]>,
    returnShapes: ReadonlyMap<string, Map<string, string[]>>,
  ): string[] | undefined => {
    const current = ts.isExpression(node) ? unwrapValueExpression(node) : node;
    if (ts.isIdentifier(current)) {
      return aliases.get(current.text) ?? [current.text];
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      return ["this"];
    }
    if (
      ts.isCallExpression(current) &&
      current.arguments.length === 0 &&
      ts.isIdentifier(current.expression)
    ) {
      const direct = returnShapes.get(current.expression.text)?.get("");
      if (direct) return direct;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const left = resolveChain(current.expression, aliases, returnShapes);
      if (!left) return undefined;
      const combined =
        (left[0] === "window" || left[0] === "globalThis") && left[1] === "aidenAPI"
          ? [...left.slice(1), current.name.text]
          : [...left, current.name.text];
      const aliased = aliases.get(combined.join("."));
      return aliased ?? combined;
    }
    return undefined;
  };

  const candidateExpressions = (expr: ts.Expression): ts.Expression[] => {
    const unwrapped = unwrapValueExpression(expr);
    if (
      ts.isBinaryExpression(unwrapped) &&
      (unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return [...candidateExpressions(unwrapped.left), ...candidateExpressions(unwrapped.right)];
    }
    return [unwrapped];
  };

  const resolveKnownChain = (
    expr: ts.Expression,
    aliases: ReadonlyMap<string, string[]>,
    returnShapes: ReadonlyMap<string, Map<string, string[]>>,
  ): string[] | undefined => {
    for (const candidate of candidateExpressions(expr)) {
      const chain = resolveChain(candidate, aliases, returnShapes);
      if (!chain) continue;
      const key = chain.join(".");
      if (namespacePrefixes.has(key) || definedMethods.has(key)) return chain;
    }
    return undefined;
  };

  const resolveCallShape = (
    expr: ts.Expression,
    aliases: ReadonlyMap<string, string[]>,
    returnShapes: ReadonlyMap<string, Map<string, string[]>>,
  ): Map<string, string[]> | undefined => {
    for (const candidate of candidateExpressions(expr)) {
      if (ts.isObjectLiteralExpression(candidate)) {
        const shape = new Map<string, string[]>();
        for (const prop of candidate.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
          ) {
            const propChain = resolveKnownChain(prop.initializer, aliases, returnShapes);
            if (propChain) shape.set(prop.name.text, propChain);
          } else if (ts.isSpreadAssignment(prop)) {
            const spreadExpr = unwrapValueExpression(prop.expression);
            if (ts.isIdentifier(spreadExpr)) {
              const prefix = `${spreadExpr.text}.`;
              for (const [aliasKey, chain] of aliases) {
                if (aliasKey.startsWith(prefix)) {
                  shape.set(aliasKey.slice(prefix.length), chain);
                }
              }
            }
          }
        }
        if (shape.size > 0) return shape;
      }
      if (!ts.isCallExpression(candidate)) continue;
      if (ts.isIdentifier(candidate.expression)) {
        const direct = returnShapes.get(candidate.expression.text);
        if (direct) return direct;
      }
      const firstArg = candidate.arguments[0];
      if (firstArg && ts.isArrowFunction(firstArg) && !ts.isBlock(firstArg.body)) {
        const nested = resolveCallShape(firstArg.body, aliases, returnShapes);
        if (nested) return nested;
      }
    }
    return undefined;
  };

  const bindParameter = (
    param: ts.ParameterDeclaration,
    chain: string[],
    targetAliases: Map<string, string[]>,
  ): void => {
    if (ts.isIdentifier(param.name)) {
      targetAliases.set(param.name.text, chain);
    } else if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const prop =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        const member = [...chain, prop];
        const key = member.join(".");
        if (namespacePrefixes.has(key) || definedMethods.has(key)) {
          targetAliases.set(element.name.text, member);
        }
      }
    }
  };

  const resolveCallable = (sf: ts.SourceFile, expr: ts.Expression): CallableTarget | undefined => {
    const unwrapped = unwrapValueExpression(expr);
    if (!ts.isIdentifier(unwrapped)) return undefined;
    const local = localCallables.get(sf)?.get(unwrapped.text);
    if (local) return local;
    const imported = importedCallables.get(sf)?.get(unwrapped.text);
    if (!imported) return undefined;
    return exportedCallables.get(imported.targetFile.fileName)?.get(imported.exportName);
  };

  for (let pass = 0; pass < 3; pass += 1) {
    for (const sf of callerFiles) {
      const aliases = aliasesByFile.get(sf)!;
      const returnShapes = returnShapesByFile.get(sf)!;

      const recordFunctionReturns = (name: string, body: ts.ConciseBody | undefined): void => {
        if (!body) return;
        const returnedExprs: ts.Expression[] = [];
        if (!ts.isBlock(body)) {
          returnedExprs.push(body);
        } else {
          for (const stmt of body.statements) {
            if (ts.isReturnStatement(stmt) && stmt.expression) returnedExprs.push(stmt.expression);
          }
        }
        for (const ret of returnedExprs) {
          const direct = resolveKnownChain(ret, aliases, returnShapes);
          if (direct) {
            const shape = returnShapes.get(name) ?? new Map<string, string[]>();
            shape.set("", direct);
            returnShapes.set(name, shape);
          }
          const unwrapped = unwrapValueExpression(ret);
          if (ts.isObjectLiteralExpression(unwrapped)) {
            for (const prop of unwrapped.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
              ) {
                const propChain = resolveKnownChain(prop.initializer, aliases, returnShapes);
                if (propChain) {
                  const shape = returnShapes.get(name) ?? new Map<string, string[]>();
                  shape.set(prop.name.text, propChain);
                  returnShapes.set(name, shape);
                }
              }
            }
          }
        }
      };

      const visit = (node: ts.Node): void => {
        if (ts.isTypeNode(node)) return;
        if (ts.isFunctionDeclaration(node) && node.name) {
          recordFunctionReturns(node.name.text, node.body);
        } else if (ts.isVariableDeclaration(node) && node.initializer) {
          if (ts.isIdentifier(node.name)) {
            const init = unwrapValueExpression(node.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              recordFunctionReturns(node.name.text, init.body);
            }
            const known = resolveKnownChain(node.initializer, aliases, returnShapes);
            if (known) aliases.set(node.name.text, known);
            const shape = resolveCallShape(node.initializer, aliases, returnShapes);
            if (shape) {
              for (const [prop, chain] of shape) {
                aliases.set(prop ? `${node.name.text}.${prop}` : node.name.text, chain);
              }
            }
          } else if (ts.isArrayBindingPattern(node.name)) {
            const first = node.name.elements[0];
            if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
              const shape = resolveCallShape(node.initializer, aliases, returnShapes);
              if (shape) {
                for (const [prop, chain] of shape) {
                  aliases.set(prop ? `${first.name.text}.${prop}` : first.name.text, chain);
                }
              }
            }
          } else if (ts.isObjectBindingPattern(node.name)) {
            const known = resolveKnownChain(node.initializer, aliases, returnShapes);
            if (known) {
              for (const element of node.name.elements) {
                if (!ts.isIdentifier(element.name)) continue;
                const prop =
                  element.propertyName && ts.isIdentifier(element.propertyName)
                    ? element.propertyName.text
                    : element.name.text;
                const member = [...known, prop];
                const key = member.join(".");
                if (namespacePrefixes.has(key) || definedMethods.has(key)) {
                  aliases.set(element.name.text, member);
                }
              }
            }
          }
        } else if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && node.initializer) {
          const known = resolveKnownChain(node.initializer, aliases, returnShapes);
          if (known) aliases.set(node.name.text, known);
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const lhs = resolveChain(node.left, aliases, returnShapes);
          const rhs = resolveKnownChain(node.right, aliases, returnShapes);
          if (lhs && rhs) aliases.set(lhs.join("."), rhs);
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const target = resolveCallable(sf, node.expression);
          if (target && node.arguments) {
            const targetAliases = aliasesByFile.get(target.file)!;
            node.arguments.forEach((arg, index) => {
              const param = target.params[index];
              if (!param) return;
              const known = resolveKnownChain(arg, aliases, returnShapes);
              if (known) bindParameter(param, known, targetAliases);
              const unwrappedArg = unwrapValueExpression(arg);
              if (ts.isIdentifier(unwrappedArg) && ts.isIdentifier(param.name)) {
                const prefix = `${unwrappedArg.text}.`;
                for (const [aliasKey, chain] of aliases) {
                  if (aliasKey.startsWith(prefix)) {
                    targetAliases.set(`${param.name.text}.${aliasKey.slice(prefix.length)}`, chain);
                  }
                }
              }
            });
          }
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (ts.isIdentifier(node.tagName)) {
            const target = resolveCallable(sf, node.tagName);
            const firstParam = target?.params[0];
            if (target && firstParam) {
              const targetAliases = aliasesByFile.get(target.file)!;
              for (const prop of node.attributes.properties) {
                if (
                  !ts.isJsxAttribute(prop) ||
                  !ts.isIdentifier(prop.name) ||
                  !prop.initializer ||
                  !ts.isJsxExpression(prop.initializer) ||
                  !prop.initializer.expression
                ) {
                  continue;
                }
                const known = resolveKnownChain(prop.initializer.expression, aliases, returnShapes);
                if (!known) continue;
                const attrName = prop.name.text;
                if (ts.isIdentifier(firstParam.name)) {
                  targetAliases.set(`${firstParam.name.text}.${attrName}`, known);
                } else if (ts.isObjectBindingPattern(firstParam.name)) {
                  for (const el of firstParam.name.elements) {
                    if (!ts.isIdentifier(el.name)) continue;
                    const propKey =
                      el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
                    if (propKey === attrName) targetAliases.set(el.name.text, known);
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  const reachable = new Set<string>();
  for (const sf of callerFiles) {
    const aliases = aliasesByFile.get(sf)!;
    const returnShapes = returnShapesByFile.get(sf)!;
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isPropertyAccessExpression(node) && !hasTypeNodeAncestor(node)) {
        const chain = resolveChain(node, aliases, returnShapes);
        if (chain) {
          const candidate = chain.join(".");
          if (definedMethods.has(candidate)) reachable.add(candidate);
        }
      } else if (ts.isIdentifier(node) && isValueReferenceIdentifier(node)) {
        const aliased = aliases.get(node.text);
        if (aliased) {
          const candidate = aliased.join(".");
          if (definedMethods.has(candidate)) reachable.add(candidate);
        } else if (topLevelFunctions.has(node.text)) {
          reachable.add(node.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const queue = [...reachable];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const deps = internalDeps.get(current);
    if (!deps) continue;
    for (const dep of deps) {
      if (!reachable.has(dep)) {
        reachable.add(dep);
        queue.push(dep);
      }
    }
  }

  return reachable;
}

interface DesktopIpcReachabilityReport {
  defined: Set<string>;
  reachable: Set<string>;
  uncalled: string[];
  staleAllowlist: string[];
  emptyReasonAllowlist: string[];
  redundantAllowlist: string[];
}

function evaluateDesktopIpcReachability(
  sources: DesktopIpcSources,
  callerFiles: readonly ts.SourceFile[],
  allowlist: Readonly<Record<string, string>>,
): DesktopIpcReachabilityReport {
  const catalog = collectDesktopIpcMethods(sources);
  const reachable = collectReachableDesktopIpcMethods(catalog, callerFiles);
  const allowlistEntries = Object.entries(allowlist);
  const staleAllowlist = sorted(
    allowlistEntries.filter(([method]) => !catalog.methods.has(method)).map(([method]) => method),
  );
  const emptyReasonAllowlist = sorted(
    allowlistEntries.filter(([, reason]) => reason.trim().length === 0).map(([method]) => method),
  );
  const redundantAllowlist = sorted(
    allowlistEntries.filter(([method]) => reachable.has(method)).map(([method]) => method),
  );
  const uncalled = sorted(
    [...catalog.methods].filter((method) => !reachable.has(method) && !(method in allowlist)),
  );
  return {
    defined: catalog.methods,
    reachable,
    uncalled,
    staleAllowlist,
    emptyReasonAllowlist,
    redundantAllowlist,
  };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const DESKTOP_IPC_DEFINITION_PATHS = new Set([
  PRELOAD_PATH,
  PRELOAD_ATTACHMENTS_PATH,
  RENDERER_IPC_PATH,
  RENDERER_IPC_VOICE_PATH,
  RENDERER_BOT_PEERS_API_PATH,
]);

const [
  sharedSources,
  mainProductionSources,
  allRendererProductionSources,
  botBubbleSources,
] = await Promise.all([
  productionSourceFiles(path.join(REPO_ROOT, "renderer", "shared")),
  productionSourceFiles(MAIN_ROOT),
  rendererProductionSourceFiles(RENDERER_ROOT),
  botBubbleRendererSources(),
]);

const rendererSourceByPath = new Map(
  allRendererProductionSources.map((sourceFile) => [sourceFile.fileName, sourceFile]),
);
const desktopIpcSources: DesktopIpcSources = {
  ipc: rendererSourceByPath.get(RENDERER_IPC_PATH)!,
  ipcVoice: rendererSourceByPath.get(RENDERER_IPC_VOICE_PATH)!,
  botPeersApi: rendererSourceByPath.get(RENDERER_BOT_PEERS_API_PATH)!,
  preload: rendererSourceByPath.get(PRELOAD_PATH)!,
  preloadAttachments: rendererSourceByPath.get(PRELOAD_ATTACHMENTS_PATH)!,
};
const rendererCallerSources = allRendererProductionSources.filter(
  (sourceFile) => !DESKTOP_IPC_DEFINITION_PATHS.has(sourceFile.fileName),
);

const inventory = collectInventory(mainProductionSources, sharedSources);
const rendererInvokes = collectRendererInvokes(
  [desktopIpcSources.ipc, desktopIpcSources.botPeersApi, ...botBubbleSources],
  sharedSources,
);
const desktopReachability = evaluateDesktopIpcReachability(
  desktopIpcSources,
  rendererCallerSources,
  DESKTOP_IPC_CALLER_ALLOWLIST,
);
const nativeChannels: ReadonlySet<string> = new Set(Object.values(NATIVE_INVOKE_CHANNELS));
const rendererHandlers = [...inventory.handlers].filter((channel) => !nativeChannels.has(channel));

test("source inventory detects literal handler and notification additions", () => {
  const source = ts.createSourceFile(
    "mutation.ts",
    `
      ipcMain.handle("new-surface:read", () => {});
      ipcMain.broadcast("new-surface:changed", {});
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mutation = collectInventory([source]);
  assert.deepEqual(sorted(mutation.handlers), ["new-surface:read"]);
  assert.deepEqual(sorted(mutation.notifications), ["new-surface:changed"]);
});

test("source inventory expands literal channel families and refuses unbounded caller interpolation", () => {
  const source = ts.createSourceFile("family.ts", 'for (const action of ["read", "save"] as const) ports.handle(`family:${action}`, () => {}); ports.handle(`family:${caller}`, () => {});', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.deepEqual(sorted(collectInventory([source]).handlers), ["family:read", "family:save"]);
});

test("source inventory resolves channel tables and renderer invoke call sites", () => {
  const shared = ts.createSourceFile(
    "shared.ts",
    `export const SURFACE_CHANNELS = { read: "surface:read", changed: "surface:changed" } as const;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const handlers = ts.createSourceFile(
    "handlers.ts",
    `
      deps.handle(SURFACE_CHANNELS.read, () => {});
      ipcMain.broadcast(SURFACE_CHANNELS.changed, {});
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const client = ts.createSourceFile(
    "ipc.ts",
    `
      export const surface = {
        read: () => invoke<string>(SURFACE_CHANNELS.read),
        write: (value: string) => invoke<void>("surface:write", value),
      };
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mutation = collectInventory([handlers], [shared]);
  assert.deepEqual(sorted(mutation.handlers), ["surface:read"]);
  assert.deepEqual(sorted(mutation.notifications), ["surface:changed"]);
  assert.deepEqual(sorted(collectRendererInvokes([client], [shared])), ["surface:read", "surface:write"]);
});

test("Bot IPC handlers and renderer Bot invokes match exactly", () => {
  // Every Bot surface (access notices, editor access, photos, Telegram binding,
  // live, memory, files, routines) is registered by main and reachable from the
  // renderer client; neither side can carry a channel the other lacks.
  const botHandlers = rendererHandlers.filter((channel) => channel.startsWith("bots:"));
  const botInvokes = [...rendererInvokes].filter((channel) => channel.startsWith("bots:"));
  assert.ok(botHandlers.length > 20, "IPC source scan found too few Bot handlers");
  assert.deepEqual(sorted(botInvokes), sorted(botHandlers), "Bot handlers and renderer/lib/ipc.ts drifted");
});

test("workspace artifact IPC handlers and renderer invokes match exactly", () => {
  const prefix = "workspaces:artifacts:";
  const handlers = rendererHandlers.filter((channel) => channel.startsWith(prefix));
  const invokes = [...rendererInvokes].filter((channel) => channel.startsWith(prefix));
  assert.ok(handlers.length > 0, "workspace artifact handlers were not found");
  assert.deepEqual(sorted(invokes), sorted(handlers), "Workspace artifact handlers and renderer/lib/ipc.ts drifted");
});

test("every live renderer-facing handler is covered by an INVOKE_PREFIX", () => {
  assert.ok(rendererHandlers.length > 80, "IPC source scan found too few handlers");
  const offenders = rendererHandlers.filter(
    (channel) => !INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix)),
  );
  assert.deepEqual(offenders, [], "live handler channels missing from preload INVOKE_PREFIXES");
});

test("every INVOKE_PREFIX has at least one live handler", () => {
  const dead = INVOKE_PREFIXES.filter(
    (prefix) => !rendererHandlers.some((channel) => channel.startsWith(prefix)),
  );
  assert.deepEqual(dead, [], "INVOKE_PREFIX with no matching live handler");
});

test("dedicated native bridge channels exactly match the live native handlers", () => {
  const liveNative = [...inventory.handlers].filter((channel) => channel.startsWith("aiden:"));
  assert.deepEqual(
    sorted(liveNative),
    sorted(nativeChannels),
    "native preload methods and native main handlers drifted",
  );
});

test("fixed attachment bridge preserves OS drop and bounded clipboard flows", async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const trustedFile = {} as File;
  const onePixelPng = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const bridge = createAttachmentPreloadBridge({
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      return [] as unknown as T;
    },
    getPathForFile: (file) => {
      if (file === trustedFile) return "/trusted/from-finder.png";
      throw new Error("not an OS-backed File");
    },
  });

  const beforeForgedDrop = calls.length;
  assert.deepEqual(
    await bridge.readDroppedFiles(
      ["/private/renderer-authored" as unknown as File],
      1,
      true,
      PRELOAD_MAX_ATTACHMENT_BYTES,
    ),
    [],
  );
  assert.equal(calls.length, beforeForgedDrop, "arbitrary path strings must not reach IPC");

  await bridge.readDroppedFiles([trustedFile], 1, true, PRELOAD_MAX_ATTACHMENT_BYTES);
  assert.deepEqual(calls[calls.length - 1], {
    channel: NATIVE_INVOKE_CHANNELS.attachmentDroppedRead,
    args: [["/trusted/from-finder.png"], 1, true, PRELOAD_MAX_ATTACHMENT_BYTES],
  });

  const clipboard = [{ mimeType: "image/png", bytes: onePixelPng }];
  await bridge.readClipboardImages(clipboard, 1, PRELOAD_MAX_ATTACHMENT_BYTES);
  assert.deepEqual(calls[calls.length - 1], {
    channel: NATIVE_INVOKE_CHANNELS.attachmentClipboardRead,
    args: [clipboard, 1, PRELOAD_MAX_ATTACHMENT_BYTES],
  });

  const maximumImage = new Uint8Array(PRELOAD_MAX_IMAGE_BYTES);
  maximumImage.set(onePixelPng);
  const beforeOversizedClipboard = calls.length;
  await assert.rejects(
    bridge.readClipboardImages(
      Array.from({ length: 5 }, () => ({ mimeType: "image/png", bytes: maximumImage })),
      5,
      PRELOAD_MAX_ATTACHMENT_BYTES,
    ),
    /aggregate byte limit/u,
  );
  assert.equal(calls.length, beforeOversizedClipboard, "oversized bytes must not reach IPC");
  await assert.rejects(
    bridge.readDroppedFiles(
      Array.from({ length: PRELOAD_MAX_ATTACHMENT_PATHS + 1 }, () => trustedFile),
      PRELOAD_MAX_ATTACHMENT_PATHS,
      true,
      PRELOAD_MAX_ATTACHMENT_BYTES,
    ),
    /Invalid dropped file selection/u,
  );

  assert.equal(PRELOAD_MAX_ATTACHMENT_PATHS, MAX_ATTACHMENTS_PER_MESSAGE);
  assert.equal(PRELOAD_MAX_CLIPBOARD_IMAGES, MAX_CLIPBOARD_IMAGES);
  assert.equal(PRELOAD_MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  assert.equal(PRELOAD_MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BATCH_BYTES);
});

test("generic renderer IPC exposes only the main-owned picker, never path reads", async () => {
  const [preload, rendererIpc, attachmentHandler] = await Promise.all([
    fs.readFile(PRELOAD_PATH, "utf8"),
    fs.readFile(RENDERER_IPC_PATH, "utf8"),
    fs.readFile(ATTACHMENT_HANDLER_PATH, "utf8"),
  ]);
  assert.match(preload, /import \{ contextBridge, ipcRenderer, webUtils \} from "electron"/u);
  assert.match(preload, /getPathForFile: \(file: File\) => webUtils\.getPathForFile\(file\)/u);
  assert.doesNotMatch(preload, /file\.path/u);
  assert.equal(INVOKE_PREFIXES.includes("attachments:"), true);
  assert.match(rendererIpc, /"attachments:pickAndRead"/u);
  assert.doesNotMatch(rendererIpc, /attachments:(?:drop|read|clipboard)/u);
  assert.match(attachmentHandler, /"attachments:pickAndRead"/u);
  assert.match(attachmentHandler, /"aiden:attachments:dropped-read"/u);
  assert.match(attachmentHandler, /"aiden:attachments:clipboard-read"/u);
});

test("live notification sites exactly match the preload notification allowlist", () => {
  assert.deepEqual(
    sorted(inventory.notifications),
    sorted(NOTIFICATION_CHANNELS),
    "main notification sites and preload NOTIFICATION_CHANNELS drifted",
  );
});

test("every Quick Chat preload invoke and notification channel exists in live main inventory", () => {
  const missingHandlers = [...QUICK_CHAT_INVOKE_CHANNELS].filter(
    (channel) => !inventory.handlers.has(channel),
  );
  assert.deepEqual(missingHandlers, [], "Quick Chat invoke channels missing from main handlers");

  const missingNotifications = [...QUICK_CHAT_NOTIFICATION_CHANNELS].filter(
    (channel) => !inventory.notifications.has(channel),
  );
  assert.deepEqual(
    missingNotifications,
    [],
    "Quick Chat notification channels missing from main notification sites",
  );
});

test("every Bot bubble overlay preload channel exists in live main inventory", () => {
  const missingHandlers = [...BOT_BUBBLES_INVOKE_CHANNELS].filter((channel) => !inventory.handlers.has(channel));
  assert.deepEqual(missingHandlers, [], "Bot bubble overlay invoke channels missing from main handlers");
  const missingNotifications = [...BOT_BUBBLES_NOTIFICATION_CHANNELS].filter(
    (channel) => !inventory.notifications.has(channel),
  );
  assert.deepEqual(missingNotifications, [], "Bot bubble overlay notification channels missing from main notification sites");
});

test("handler bootstrap registers every dedicated handler surface", async () => {
  const bootstrap = await fs.readFile(HANDLER_BOOTSTRAP_PATH, "utf8");

  for (const registration of ["registerSubagentHandlers", "registerTelegramHandlers"]) {
    assert.match(
      bootstrap,
      new RegExp(`import \\{ ${registration} \\} from "\\./[a-z-]+\\.js";`, "u"),
      `${registration} must be imported by the IPC bootstrap`,
    );
    assert.match(
      bootstrap,
      new RegExp(`\\b${registration}\\(\\);`, "u"),
      `${registration} must be invoked by the IPC bootstrap`,
    );
  }
});

test("every desktop IPC client and preload method has an active renderer caller or valid allowlist exemption", () => {
  assert.ok(desktopReachability.defined.size > 250, "desktop IPC method scan found too few methods");
  assert.deepEqual(
    desktopReachability.staleAllowlist,
    [],
    "DESKTOP_IPC_CALLER_ALLOWLIST contains stale entries that no longer exist in renderer/",
  );
  assert.deepEqual(
    desktopReachability.emptyReasonAllowlist,
    [],
    "DESKTOP_IPC_CALLER_ALLOWLIST entries must document a non-empty reason",
  );
  assert.deepEqual(
    desktopReachability.redundantAllowlist,
    [],
    "DESKTOP_IPC_CALLER_ALLOWLIST contains methods that now have active callers in renderer/",
  );
  assert.deepEqual(
    desktopReachability.uncalled,
    [],
    "uncalled desktop IPC methods in renderer/lib/ipc.ts, bot-peers-api.ts, or preload.ts must be deleted with their main handlers or explicitly allowlisted",
  );
});

test("caller reachability fails on uncalled ipc.ts, bot-peers-api.ts, or preload.ts mutations unless allowlisted and rejects stale allowlist entries", () => {
  const mutatedIpc = ts.createSourceFile(
    RENDERER_IPC_PATH,
    `${desktopIpcSources.ipc.text}\nexport const mutatedTestApi = { orphanAction: () => invoke<void>("app:orphan") };\n`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ipcReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, ipc: mutatedIpc },
    rendererCallerSources,
    DESKTOP_IPC_CALLER_ALLOWLIST,
  );
  assert.deepEqual(ipcReport.uncalled, ["mutatedTestApi.orphanAction"]);

  const allowlistedIpcReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, ipc: mutatedIpc },
    rendererCallerSources,
    { ...DESKTOP_IPC_CALLER_ALLOWLIST, "mutatedTestApi.orphanAction": "intentional test exemption" },
  );
  assert.deepEqual(allowlistedIpcReport.uncalled, []);
  assert.deepEqual(allowlistedIpcReport.staleAllowlist, []);

  const mutatedBotPeers = ts.createSourceFile(
    RENDERER_BOT_PEERS_API_PATH,
    desktopIpcSources.botPeersApi.text.replace(
      "return {",
      'return {\n    orphanPeerMethod: async () => invoke("bots:peers:orphan", {}),',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const botPeersReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, botPeersApi: mutatedBotPeers },
    rendererCallerSources,
    DESKTOP_IPC_CALLER_ALLOWLIST,
  );
  assert.deepEqual(botPeersReport.uncalled, ["botsApi.peers.orphanPeerMethod"]);

  const allowlistedBotPeersReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, botPeersApi: mutatedBotPeers },
    rendererCallerSources,
    {
      ...DESKTOP_IPC_CALLER_ALLOWLIST,
      "botsApi.peers.orphanPeerMethod": "intentional peer test exemption",
    },
  );
  assert.deepEqual(allowlistedBotPeersReport.uncalled, []);

  const mutatedPreload = ts.createSourceFile(
    PRELOAD_PATH,
    desktopIpcSources.preload.text.replace(
      "const aidenAPI = {",
      'const aidenAPI = {\n  orphanBridge: { orphanNativeAction: () => ipcRenderer.invoke("aiden:orphan:action") },',
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const preloadReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, preload: mutatedPreload },
    rendererCallerSources,
    DESKTOP_IPC_CALLER_ALLOWLIST,
  );
  assert.deepEqual(preloadReport.uncalled, ["aidenAPI.orphanBridge.orphanNativeAction"]);

  const allowlistedPreloadReport = evaluateDesktopIpcReachability(
    { ...desktopIpcSources, preload: mutatedPreload },
    rendererCallerSources,
    {
      ...DESKTOP_IPC_CALLER_ALLOWLIST,
      "aidenAPI.orphanBridge.orphanNativeAction": "intentional preload test exemption",
    },
  );
  assert.deepEqual(allowlistedPreloadReport.uncalled, []);

  const staleAllowlistReport = evaluateDesktopIpcReachability(
    desktopIpcSources,
    rendererCallerSources,
    { ...DESKTOP_IPC_CALLER_ALLOWLIST, "chatsApi.nonExistentRetiredMethod": "stale exemption" },
  );
  assert.deepEqual(staleAllowlistReport.staleAllowlist, ["chatsApi.nonExistentRetiredMethod"]);
});
