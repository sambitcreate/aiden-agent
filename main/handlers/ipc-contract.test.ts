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
  return undefined;
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
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return constants;
}

function collectInventory(sourceFiles: readonly ts.SourceFile[]): IpcInventory {
  const inventory: IpcInventory = {
    handlers: new Set(),
    notifications: new Set(),
  };
  const channelConstants = collectChannelConstants(sourceFiles);

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name === "handle") {
          const channel = literalValue(node.arguments[0], channelConstants);
          if (channel) inventory.handlers.add(channel);
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

async function productionSourceFiles(directory: string): Promise<ts.SourceFile[]> {
  const sourceFiles: ts.SourceFile[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures") sourceFiles.push(...(await productionSourceFiles(target)));
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

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const inventory = collectInventory(await productionSourceFiles(MAIN_ROOT));
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
