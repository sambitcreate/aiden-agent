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
import type { AuthPrompt } from "@earendil-works/pi-ai";
import {
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_CLIPBOARD_IMAGES,
  MAX_IMAGE_BYTES,
} from "../services/attachments.js";
import {
  OPENAI_CODEX_PROVIDER_ID as MainCodexProviderId,
  type CodexModelSummary as MainCodexModelSummary,
  type CodexProviderSnapshot as MainCodexProviderSnapshot,
} from "../services/codex-provider.js";
import type {
  GitCommitCapability as MainGitCommitCapability,
  GitComparison as MainGitComparison,
  GitFileDiff as MainGitFileDiff,
  GitPushResult as MainGitPushResult,
  GitReview as MainGitReview,
} from "../services/git.js";
import type { HookBlockedPromptV1 as MainHookBlockedPromptV1 } from "../services/hook-blocked-prompt.js";
import type {
  ProviderAuthDoneDto,
  ProviderAuthErrorDto,
  ProviderAuthEventDto,
  ProviderAuthPromptDto,
  ProviderAuthPromptType as MainProviderAuthPromptType,
  ProviderAuthSelectOptionDto,
} from "../services/provider-auth-flow-core.js";
import type { SubagentRole } from "../services/subagents/capability-profile.js";
import type {
  SubagentModelRoleSetting as MainSubagentModelRoleSetting,
  SubagentModelSettings as MainSubagentModelSettings,
} from "../services/subagents/subagent-model-selection.js";
import type {
  AppSettings as MainAppSettings,
  AssistantConfig as MainAssistantConfig,
  Chat as MainChat,
  ChatMessage as MainChatMessage,
  ChatMeta as MainChatMeta,
  ChatStartParams as MainChatStartParams,
  DiscoveredSkill as MainDiscoveredSkill,
  ManagedWorktree as MainManagedWorktree,
  Provider as MainProvider,
  ScheduledRun as MainScheduledRun,
  ScheduledTask as MainScheduledTask,
  ScheduledTaskInput as MainScheduledTaskInput,
  StoredProvider as MainStoredProvider,
  UsageTokenBreakdown as MainUsageTokenBreakdown,
} from "../services/types.js";
import type {
  WorkspaceFileEntry as MainWorkspaceFileEntry,
  WorkspaceFileIndex as MainWorkspaceFileIndex,
} from "../services/workspace-files.js";
import {
  OPENAI_CODEX_PROVIDER_ID as RendererCodexProviderId,
  type AppSettings as RendererAppSettings,
  type AssistantConfig as RendererAssistantConfig,
  type Chat as RendererChat,
  type ChatMessage as RendererChatMessage,
  type ChatMeta as RendererChatMeta,
  type ChatMetadataUpdated,
  type ChatStartParams as RendererChatStartParams,
  type CodexModelSummary as RendererCodexModelSummary,
  type CodexProviderSnapshot as RendererCodexProviderSnapshot,
  type DiscoveredSkill as RendererDiscoveredSkill,
  type GitCommitCapability as RendererGitCommitCapability,
  type GitComparison as RendererGitComparison,
  type GitFileDiff as RendererGitFileDiff,
  type GitPushResult as RendererGitPushResult,
  type GitReview as RendererGitReview,
  type HookBlockedPromptV1 as RendererHookBlockedPromptV1,
  type ManagedWorktree as RendererManagedWorktree,
  type Provider as RendererProvider,
  type ProviderAuthDone as RendererProviderAuthDone,
  type ProviderAuthError as RendererProviderAuthError,
  type ProviderAuthEvent as RendererProviderAuthEvent,
  type ProviderAuthPrompt as RendererProviderAuthPrompt,
  type ProviderAuthSelectOption as RendererProviderAuthSelectOption,
  type ScheduledRun as RendererScheduledRun,
  type ScheduledTask as RendererScheduledTask,
  type ScheduledTaskInput as RendererScheduledTaskInput,
  type SubagentModelRoleSetting as RendererSubagentModelRoleSetting,
  type SubagentModelSettings as RendererSubagentModelSettings,
  type UsageTokenBreakdown as RendererUsageTokenBreakdown,
  type WorkspaceFileEntry as RendererWorkspaceFileEntry,
  type WorkspaceFileIndex as RendererWorkspaceFileIndex,
} from "../../renderer/lib/types.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../renderer/shared/attachment-contract.js";
import type { ChatMetadataUpdatedPatch } from "../../renderer/shared/chat-metadata-update.js";
import { OPENAI_CODEX_PROVIDER_ID as SharedCodexProviderId } from "../../renderer/shared/ipc-provider-contracts.js";
import type { SubagentSnapshotRole } from "../../renderer/shared/subagent-runs.js";

interface IpcInventory {
  handlers: Set<string>;
  notifications: Set<string>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_ROOT = path.join(REPO_ROOT, "main");
const PRELOAD_PATH = path.join(REPO_ROOT, "renderer", "preload.ts");
const RENDERER_IPC_PATH = path.join(REPO_ROOT, "renderer", "lib", "ipc.ts");
const ATTACHMENT_HANDLER_PATH = path.join(MAIN_ROOT, "handlers", "attachments.ts");

const HANDLER_BOOTSTRAP_PATH = path.join(MAIN_ROOT, "handlers", "index.ts");
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

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const sharedSources = await productionSourceFiles(path.join(REPO_ROOT, "renderer", "shared"));
const mainSources = await productionSourceFiles(MAIN_ROOT);
const rendererLibSources = await productionSourceFiles(path.join(REPO_ROOT, "renderer", "lib"));
const inventory = collectInventory(mainSources, sharedSources);
const rendererInvokes = collectRendererInvokes(
  [
    ts.createSourceFile(
      RENDERER_IPC_PATH,
      await fs.readFile(RENDERER_IPC_PATH, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
    ts.createSourceFile(
      "bot-peers-api.ts",
      await fs.readFile(path.join(REPO_ROOT, "renderer/lib/bot-peers-api.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
    ...(await botBubbleRendererSources()),
  ],
  sharedSources,
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

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

function verifySharedIpcTypeContracts(): true {
  const _exactChecks: [
    AssertExact<RendererProvider, MainProvider>,
    AssertExact<RendererCodexModelSummary, MainCodexModelSummary>,
    AssertExact<RendererCodexProviderSnapshot, MainCodexProviderSnapshot>,
    AssertExact<RendererProviderAuthSelectOption, ProviderAuthSelectOptionDto>,
    AssertExact<RendererProviderAuthPrompt, ProviderAuthPromptDto>,
    AssertExact<RendererProviderAuthEvent, ProviderAuthEventDto>,
    AssertExact<RendererProviderAuthDone, ProviderAuthDoneDto>,
    AssertExact<RendererProviderAuthError, ProviderAuthErrorDto>,
    AssertExact<MainProviderAuthPromptType, AuthPrompt["type"]>,
    AssertExact<RendererManagedWorktree, MainManagedWorktree>,
    AssertExact<RendererGitReview, MainGitReview>,
    AssertExact<RendererGitCommitCapability, MainGitCommitCapability>,
    AssertExact<RendererGitPushResult, MainGitPushResult>,
    AssertExact<RendererGitComparison, MainGitComparison>,
    AssertExact<RendererGitFileDiff, MainGitFileDiff>,
    AssertExact<RendererHookBlockedPromptV1, MainHookBlockedPromptV1>,
    AssertExact<RendererDiscoveredSkill, MainDiscoveredSkill>,
    AssertExact<RendererAssistantConfig, MainAssistantConfig>,
    AssertExact<RendererSubagentModelRoleSetting, MainSubagentModelRoleSetting>,
    AssertExact<RendererSubagentModelSettings, MainSubagentModelSettings>,
    AssertExact<SubagentSnapshotRole, SubagentRole>,
    AssertExact<RendererAppSettings, MainAppSettings>,
    AssertExact<RendererUsageTokenBreakdown, MainUsageTokenBreakdown>,
    AssertExact<ChatMetadataUpdated, ChatMetadataUpdatedPatch>,
  ] = [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
  ];
  void _exactChecks;

  // Restored and Agent Slider fields exposed identically in renderer contracts.
  const _worktree: RendererManagedWorktree = {
    repositoryPath: "/repo",
    worktreePath: "/repo/.worktrees/wt",
    branch: "feat/x",
    createdFromHead: "abc123",
    provisionedFiles: [".env.local"],
  };
  const _skill: RendererDiscoveredSkill = {
    id: "skill-1",
    name: "Skill",
    description: "Desc",
    instructions: "Do x",
    source: "workspace",
    path: "/repo/.agents/skills/skill/SKILL.md",
    modelInvocable: true,
    userInvocable: false,
  };
  const _settings: RendererAppSettings = {
    lastThinkingLevel: "high",
    agentSlider: {
      version: 1,
      stops: [{ id: "stop_00000001", label: "Balanced" }],
      homeStopId: "stop_00000001",
    },
    agentSliderUnreadable: true,
    subagentModels: {
      defaultModel: "openai::gpt-5",
      defaultEffort: "medium",
      roles: { reviewer: { effort: "high", locked: true } },
    },
  };
  const _tokens: RendererUsageTokenBreakdown = {
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheWrite: 4,
    cacheWrite1h: 2,
    reasoning: 3,
    total: 30,
  };
  const _chatMeta: RendererChatMeta = {
    id: "chat-1",
    title: "Chat",
    thinkingLevel: "medium",
    createdAt: 1,
    updatedAt: 2,
  };
  const _rendererChat: RendererChat = {
    ..._chatMeta,
    imageArtifactRecoveryPending: true,
    imageArtifactRecoveryUnavailable: false,
    messages: [],
  };
  const _storedProvider: MainStoredProvider = {
    id: "custom",
    kind: "openai",
    label: "Custom",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
    needsKey: false,
  };
  const _mainIndex: MainWorkspaceFileIndex = {
    entries: [
      {
        path: "a.ts",
        name: "a.ts",
        parentPath: "",
        depth: 0,
        kind: "file",
        filesystemDevice: "1",
        filesystemInode: "2",
      },
    ],
    truncated: false,
    skippedDirectories: 0,
  };
  const _rendererIndex: RendererWorkspaceFileIndex = {
    entries: [{ path: "a.ts", name: "a.ts", parentPath: "", depth: 0, kind: "file" }],
    truncated: false,
    skippedDirectories: 0,
  };
  void _worktree;
  void _skill;
  void _settings;
  void _tokens;
  void _rendererChat;
  void _storedProvider;
  void _mainIndex;
  void _rendererIndex;

  // 1. Renderer WorkspaceFileEntry rejects main-only filesystemDevice / filesystemInode.
  const _badFileDevice: RendererWorkspaceFileEntry = {
    path: "a.ts",
    name: "a.ts",
    parentPath: "",
    depth: 0,
    kind: "file",
    // @ts-expect-error filesystemDevice is main-only on WorkspaceFileEntry
    filesystemDevice: "dev-1",
  };
  const _badFileInode: RendererWorkspaceFileEntry = {
    path: "a.ts",
    name: "a.ts",
    parentPath: "",
    depth: 0,
    kind: "file",
    // @ts-expect-error filesystemInode is main-only on WorkspaceFileEntry
    filesystemInode: "ino-1",
  };
  const _goodMainFile: MainWorkspaceFileEntry = {
    path: "a.ts",
    name: "a.ts",
    parentPath: "",
    depth: 0,
    kind: "file",
    filesystemDevice: "dev-1",
    filesystemInode: "ino-1",
  };

  // 2. Renderer ChatMessage rejects main-only pi protocol payload.
  const _badChatMessage: RendererChatMessage = {
    id: "msg-1",
    role: "assistant",
    content: "hi",
    createdAt: 1,
    // @ts-expect-error pi protocol payload is main-only on ChatMessage
    pi: {},
  };
  const _goodMainMessage: Pick<MainChatMessage, "id" | "pi"> = { id: "msg-1", pi: undefined };

  // 3. Renderer ChatMeta rejects main-only preview and summaryRevision.
  const _badChatMetaPreview: RendererChatMeta = {
    id: "chat-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 2,
    // @ts-expect-error preview is main-only on ChatMeta
    preview: "secret preview",
  };
  const _badChatMetaRevision: RendererChatMeta = {
    id: "chat-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 2,
    // @ts-expect-error summaryRevision is main-only on ChatMeta
    summaryRevision: "rev-1",
  };
  const _goodMainMeta: MainChatMeta = {
    id: "chat-1",
    title: "Chat",
    preview: "ok",
    summaryRevision: "rev-1",
    createdAt: 1,
    updatedAt: 2,
  };

  // 4. Renderer Chat rejects main-only firstMessageCommit (and main Chat rejects renderer recovery flags).
  const _badRendererChat: RendererChat = {
    id: "chat-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    // @ts-expect-error firstMessageCommit is main-only on Chat
    firstMessageCommit: { turnId: "t1", fingerprint: "fp" },
  };
  const _badMainChatRecovery: MainChat = {
    id: "chat-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    // @ts-expect-error imageArtifactRecoveryPending is renderer-only on Chat
    imageArtifactRecoveryPending: true,
  };

  // 5. Renderer ScheduledTask rejects main-only Bot routine and fingerprint fields.
  const _baseTask: RendererScheduledTask = {
    id: "task-1",
    name: "Task",
    enabled: true,
    mode: "llm",
    cron: "0 9 * * *",
    timezone: "UTC",
    permission: "read-only",
    notify: true,
    createdAt: 1,
    updatedAt: 2,
  };
  const _badTaskBot: RendererScheduledTask = {
    ..._baseTask,
    // @ts-expect-error botId is main-only on ScheduledTask
    botId: "bot-1",
  };
  const _badTaskFingerprint: RendererScheduledTask = {
    ..._baseTask,
    // @ts-expect-error providerFingerprint is main-only on ScheduledTask
    providerFingerprint: "fp-1",
  };
  const _badTaskFires: RendererScheduledTask = {
    ..._baseTask,
    // @ts-expect-error pendingRoutineFires is main-only on ScheduledTask
    pendingRoutineFires: [],
  };
  const _goodMainTask: MainScheduledTask = {
    ..._baseTask,
    botId: "bot-1",
    providerFingerprint: "fp-1",
    pendingRoutineFires: [],
  };

  // 6. Renderer ScheduledRun rejects main-only routineTiming, reason, failure, and fingerprint fields.
  const _baseRun: RendererScheduledRun = {
    id: "run-1",
    taskId: "task-1",
    startedAt: 1,
    finishedAt: 2,
    result: "success",
    output: "done",
  };
  const _badRunReason: RendererScheduledRun = {
    ..._baseRun,
    // @ts-expect-error reason is main-only on ScheduledRun
    reason: "duplicate",
  };
  const _badRunFingerprint: RendererScheduledRun = {
    ..._baseRun,
    // @ts-expect-error fingerprint is main-only on ScheduledRun
    fingerprint: "fp-run",
  };
  const _goodMainRun: MainScheduledRun = {
    ..._baseRun,
    reason: "duplicate",
    fingerprint: "fp-run",
    byHand: true,
  };

  // 7. Renderer ScheduledTaskInput rejects main-only bindings, originChatId, and Bot routine fields.
  const _baseTaskInput: RendererScheduledTaskInput = {
    name: "Task",
    mode: "llm",
    cron: "0 9 * * *",
  };
  const _badInputFingerprint: RendererScheduledTaskInput = {
    ..._baseTaskInput,
    // @ts-expect-error providerFingerprint is main-only on ScheduledTaskInput
    providerFingerprint: "fp-1",
  };
  const _badInputOriginChat: RendererScheduledTaskInput = {
    ..._baseTaskInput,
    // @ts-expect-error originChatId is main-only on ScheduledTaskInput
    originChatId: "chat-1",
  };
  const _badInputBot: RendererScheduledTaskInput = {
    ..._baseTaskInput,
    // @ts-expect-error botId is main-only on ScheduledTaskInput
    botId: "bot-1",
  };
  const _goodMainInput: MainScheduledTaskInput = {
    ..._baseTaskInput,
    providerFingerprint: "fp-1",
    originChatId: "chat-1",
    botId: "bot-1",
  };

  // 8. Renderer ChatStartParams rejects main-only messages and unattended Assistant modes.
  const _baseStartParams: RendererChatStartParams = {
    chatId: "chat-1",
    providerId: "openai",
    model: "gpt-5",
    mode: "assistant",
  };
  const _badStartMessages: RendererChatStartParams = {
    ..._baseStartParams,
    // @ts-expect-error messages is main-only on ChatStartParams
    messages: [],
  };
  const _badStartUnattended: RendererChatStartParams = {
    ..._baseStartParams,
    // @ts-expect-error unattended Assistant mode is main-only on ChatStartParams
    mode: "assistant-unattended",
  };
  const _badStartAutomation: RendererChatStartParams = {
    ..._baseStartParams,
    // @ts-expect-error automation Assistant mode is main-only on ChatStartParams
    mode: "assistant-automation",
  };
  const _goodMainStart: MainChatStartParams = {
    ..._baseStartParams,
    mode: "assistant-unattended",
    messages: [{ role: "user", content: "hello" }],
  };

  void _badFileDevice;
  void _badFileInode;
  void _goodMainFile;
  void _badChatMessage;
  void _goodMainMessage;
  void _badChatMetaPreview;
  void _badChatMetaRevision;
  void _goodMainMeta;
  void _badRendererChat;
  void _badMainChatRecovery;
  void _badTaskBot;
  void _badTaskFingerprint;
  void _badTaskFires;
  void _goodMainTask;
  void _badRunReason;
  void _badRunFingerprint;
  void _goodMainRun;
  void _badInputFingerprint;
  void _badInputOriginChat;
  void _badInputBot;
  void _goodMainInput;
  void _badStartMessages;
  void _badStartUnattended;
  void _badStartAutomation;
  void _goodMainStart;
  return true;
}

function topLevelDeclaredTypeAndValueNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

test("shared IPC domain contract modules unify main and renderer types without cross-process duplication", () => {
  assert.equal(verifySharedIpcTypeContracts(), true);
  assert.equal(SharedCodexProviderId, "openai-codex");
  assert.equal(MainCodexProviderId, SharedCodexProviderId);
  assert.equal(RendererCodexProviderId, SharedCodexProviderId);

  const expectedSharedModules = [
    "ipc-chat-schedule-contracts.ts",
    "ipc-provider-contracts.ts",
    "ipc-settings-usage-contracts.ts",
    "ipc-workspace-git-contracts.ts",
  ];
  const domainModules = sharedSources.filter((sf) =>
    expectedSharedModules.includes(path.basename(sf.fileName)),
  );
  assert.deepEqual(
    sorted(domainModules.map((sf) => path.basename(sf.fileName))),
    expectedSharedModules,
  );

  // Guardrail: domain contract modules must use relative .js specifiers and have
  // zero runtime imports and zero imports from Electron, Node, or @earendil-works/pi-ai.
  for (const domainModule of domainModules) {
    const fileLabel = path.basename(domainModule.fileName);
    for (const statement of domainModule.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        assert.equal(
          statement.importClause?.isTypeOnly,
          true,
          `${fileLabel} import "${specifier}" must be import type`,
        );
        assert.equal(
          /^\.{1,2}\/.+\.js$/u.test(specifier),
          true,
          `${fileLabel} import "${specifier}" must be a relative .js specifier`,
        );
        assert.equal(
          specifier === "electron" ||
            specifier.startsWith("node:") ||
            specifier.startsWith("@earendil-works/pi-ai"),
          false,
          `${fileLabel} must not import "${specifier}"`,
        );
      }
    }
  }

  const rendererTypesSource = rendererLibSources.find(
    (sf) => path.basename(sf.fileName) === "types.ts",
  );
  assert.ok(rendererTypesSource, "renderer/lib/types.ts was not found");

  const unifiedMainServiceFiles = new Set([
    path.join(MAIN_ROOT, "services", "types.ts"),
    path.join(MAIN_ROOT, "services", "codex-provider.ts"),
    path.join(MAIN_ROOT, "services", "provider-auth-flow-core.ts"),
    path.join(MAIN_ROOT, "services", "git.ts"),
    path.join(MAIN_ROOT, "services", "workspace-files.ts"),
    path.join(MAIN_ROOT, "services", "hook-blocked-prompt.ts"),
    path.join(MAIN_ROOT, "services", "subagents", "subagent-model-selection.ts"),
  ]);
  const mainServiceDeclaredNames = new Set<string>();
  for (const sf of mainSources) {
    if (!unifiedMainServiceFiles.has(sf.fileName)) continue;
    for (const name of topLevelDeclaredTypeAndValueNames(sf)) {
      mainServiceDeclaredNames.add(name);
    }
  }
  const rendererLocalNames = topLevelDeclaredTypeAndValueNames(rendererTypesSource);
  const duplicatedAcrossProcesses = [...rendererLocalNames].filter((name) =>
    mainServiceDeclaredNames.has(name),
  );
  assert.deepEqual(
    sorted(duplicatedAcrossProcesses),
    [],
    "renderer/lib/types.ts must re-export shared IPC types rather than redeclaring main/services symbols",
  );

  // StoredProvider must stay unexported from renderer/lib/types.ts.
  const rendererExportedSpecifiers = new Set<string>();
  let chatMetadataAliasTarget: string | undefined;
  for (const statement of rendererTypesSource.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        rendererExportedSpecifiers.add(element.name.text);
      }
    }
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === "ChatMetadataUpdated") {
      if (ts.isTypeReferenceNode(statement.type) && ts.isIdentifier(statement.type.typeName)) {
        chatMetadataAliasTarget = statement.type.typeName.text;
      }
    }
  }
  assert.equal(rendererExportedSpecifiers.has("StoredProvider"), false);
  assert.equal(rendererExportedSpecifiers.has("AssistantConfig"), true);
  assert.equal(chatMetadataAliasTarget, "ChatMetadataUpdatedPatch");
});
