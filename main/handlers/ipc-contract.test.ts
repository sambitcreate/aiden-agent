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

interface IpcInventory {
  handlers: Set<string>;
  notifications: Set<string>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_ROOT = path.join(REPO_ROOT, "main");

function calleeName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function isIpcHandle(expression: ts.LeftHandSideExpression): boolean {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "handle") return false;
  return (
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "ipcMain" || expression.expression.text === "electronIpcMain")
  );
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
        if (name === "handle" && isIpcHandle(node.expression)) {
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

test("native dropped-file import cannot be invoked through the generic renderer bridge", () => {
  const channel = NATIVE_INVOKE_CHANNELS.createImagesImportDroppedFiles;
  assert.equal(
    INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix)),
    false,
  );
});

test("live notification sites exactly match the preload notification allowlist", () => {
  assert.deepEqual(
    sorted(inventory.notifications),
    sorted(NOTIFICATION_CHANNELS),
    "main notification sites and preload NOTIFICATION_CHANNELS drifted",
  );
});
