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
import { createLazyModule } from "../lazy-module.js";
import { createLoadedSubsystemRegistry } from "../loaded-subsystems.js";
import {
  createIpcCaptureScope,
  createLazyIpcGroup,
  type IpcInvokeHandler,
} from "./lazy-ipc-core.js";

interface IpcInventory {
  handlers: Set<string>;
  notifications: Set<string>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_ROOT = path.join(REPO_ROOT, "main");
const PRELOAD_PATH = path.join(REPO_ROOT, "renderer", "preload.ts");
const RENDERER_IPC_PATH = path.join(REPO_ROOT, "renderer", "lib", "ipc.ts");
const ATTACHMENT_HANDLER_PATH = path.join(MAIN_ROOT, "handlers", "attachments.ts");
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
const inventory = collectInventory(await productionSourceFiles(MAIN_ROOT), sharedSources);
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

test("handler inventory registers every deferred subsystem surface", () => {
  for (const requiredPrefix of [
    "subagents:",
    "telegram:",
    "browser:",
    "devices:",
    "designCanvas:",
    "remote:",
    "assistant-live:",
    "chats:goal:",
  ]) {
    assert.equal(
      [...inventory.handlers].some((channel) => channel.startsWith(requiredPrefix)),
      true,
      `Expected at least one registered handler starting with ${requiredPrefix}`,
    );
  }
});

test("lazy IPC forwarder registers channels synchronously and loads the module once on first invoke", async () => {
  const registered = new Map<string, IpcInvokeHandler>();
  const scope = createIpcCaptureScope<IpcInvokeHandler>();
  const registerHandle = (channel: string, listener: IpcInvokeHandler) => {
    scope.handle(channel, listener, (targetChannel, targetListener) => {
      if (registered.has(targetChannel)) {
        throw new Error(`Duplicate top-level registration for "${targetChannel}"`);
      }
      registered.set(targetChannel, targetListener);
    });
  };

  let loaderCalls = 0;
  const group = createLazyIpcGroup(
    { handle: registerHandle, capture: (run) => scope.capture(run) },
    "demo",
    ["demo:alpha", "demo:beta"],
    async () => {
      loaderCalls += 1;
      await Promise.resolve();
      return () => {
        registerHandle("demo:alpha", (_event, value) => `alpha:${String(value)}`);
        registerHandle("demo:beta", (_event, value) => `beta:${String(value)}`);
      };
    },
  );

  // Synchronous registration happens before startup IPC admission opens, while
  // the underlying module remains unloaded until an invoke arrives.
  assert.deepEqual([...registered.keys()], ["demo:alpha", "demo:beta"]);
  assert.equal(group.isLoaded(), false);
  assert.equal(loaderCalls, 0);

  const [first, second] = await Promise.all([
    registered.get("demo:alpha")?.({}, 1),
    registered.get("demo:beta")?.({}, 2),
  ]);
  assert.equal(first, "alpha:1");
  assert.equal(second, "beta:2");
  assert.equal(group.isLoaded(), true);
  assert.equal(loaderCalls, 1);
});

test("lazy IPC forwarder rejects channel drift and retries after transient loader failure", async () => {
  const registered = new Map<string, IpcInvokeHandler>();
  const scope = createIpcCaptureScope<IpcInvokeHandler>();
  const registerHandle = (channel: string, listener: IpcInvokeHandler) => {
    scope.handle(channel, listener, (targetChannel, targetListener) => {
      registered.set(targetChannel, targetListener);
    });
  };

  const mismatched = createLazyIpcGroup(
    { handle: registerHandle, capture: (run) => scope.capture(run) },
    "mismatched",
    ["mismatch:expected"],
    async () => () => {
      registerHandle("mismatch:unexpected", () => "wrong");
    },
  );
  await assert.rejects(
    async () => await registered.get("mismatch:expected")?.({}),
    /channel mismatch: missing=\[mismatch:expected\] unexpected=\[mismatch:unexpected\]/u,
  );
  assert.equal(mismatched.isLoaded(), false);

  let attempts = 0;
  const recoverable = createLazyIpcGroup(
    { handle: registerHandle, capture: (run) => scope.capture(run) },
    "recoverable",
    ["recoverable:ping"],
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient load failure");
      return () => {
        registerHandle("recoverable:ping", () => "pong");
      };
    },
  );
  await assert.rejects(
    async () => await registered.get("recoverable:ping")?.({}),
    /transient load failure/u,
  );
  assert.equal(await registered.get("recoverable:ping")?.({}), "pong");
  assert.equal(recoverable.isLoaded(), true);
  assert.equal(attempts, 2);
});

test("lazy modules and loaded-subsystem registry skip unloaded subsystems on shutdown", async () => {
  interface TestSubsystems {
    loadedService: { stop: () => void };
    unloadedService: { stop: () => void };
  }
  const registry = createLoadedSubsystemRegistry<TestSubsystems>();
  let unloadedImports = 0;
  let loadedStopped = 0;
  let unloadedStopped = 0;

  const unloadedModule = createLazyModule(async () => {
    unloadedImports += 1;
    return registry.register("unloadedService", {
      stop: () => {
        unloadedStopped += 1;
      },
    });
  });
  const loadedModule = createLazyModule(async () =>
    registry.register("loadedService", {
      stop: () => {
        loadedStopped += 1;
      },
    }),
  );

  await loadedModule.load();
  assert.equal(loadedModule.isLoaded(), true);
  assert.equal(unloadedModule.isLoaded(), false);
  assert.equal(await unloadedModule.peekOrAwaitInFlight(), undefined);
  assert.equal(unloadedImports, 0);

  registry.peek("loadedService")?.stop();
  registry.peek("unloadedService")?.stop();

  assert.equal(loadedStopped, 1);
  assert.equal(unloadedStopped, 0);
  assert.equal(unloadedImports, 0);
});
