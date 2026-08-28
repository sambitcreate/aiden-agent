import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("Settings exposes local-only reveal export delete and explicit crash consent", () => {
  const component = source("renderer/components/settings/diagnostics-settings.tsx");
  assert.match(component, /Nothing is uploaded automatically/u);
  assert.match(component, /diagnosticsApi\.reveal/u);
  assert.match(component, /diagnosticsApi\.export\(includeCrashDumps\)/u);
  assert.match(component, /diagnosticsApi\.delete/u);
  assert.match(component, /Memory dumps can contain prompts, workspace content, credentials/u);
  assert.match(component, /confirmVariant="destructive"/u);
  assert.match(component, /returnFocus/u);
  assert.match(component, /Active until Aiden restarts/u);
});

test("renderer fault forwarding is main-policy-owned, categorical, and rate-limited", () => {
  const diagnostics = source("renderer/lib/dev-log.ts");
  const rootEntry = source("renderer/main/index.tsx");
  const boundary = source("renderer/components/ui.tsx");
  assert.doesNotMatch(diagnostics, /import\.meta\.env\.DEV|\.message|\.stack|String\(reason\)/u);
  assert.match(diagnostics, /diagnosticsApi\.policy\(\)/u);
  assert.match(diagnostics, /state\.sent < policy\.maxPerKey/u);
  assert.match(diagnostics, /suppressed/u);
  assert.match(rootEntry, /onUncaughtError/u);
  assert.match(rootEntry, /onCaughtError/u);
  assert.match(rootEntry, /onRecoverableError/u);
  assert.match(boundary, /componentDidCatch/u);
  assert.match(boundary, /Reference \{referenceId\}/u);
  assert.doesNotMatch(boundary, /error\.message/u);
});

test("diagnostic IPC surface does not retain the arbitrary devlog writer", () => {
  const handlers = source("main/handlers/diagnostics.ts");
  const index = source("main/handlers/index.ts");
  assert.match(handlers, /parseRendererReport/u);
  assert.match(handlers, /uploadToServer: false/u);
  assert.doesNotMatch(index, /devlog:write|String\(message\)/u);
});
