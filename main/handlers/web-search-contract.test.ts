import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { INVOKE_PREFIXES } from "../../renderer/preload-channels.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function source(file: string): Promise<string> {
  return fs.readFile(path.join(REPO_ROOT, file), "utf8");
}

test("Web Search IPC has one fenced, registry-backed channel surface", async () => {
  const phase2 = await source("main/handlers/phase2.ts");
  const webSearchStart = phase2.indexOf("// ── Web Search settings and credentials");
  const voiceStart = phase2.indexOf("// ── Voice transcription", webSearchStart);
  assert.ok(webSearchStart >= 0);
  assert.ok(voiceStart > webSearchStart);
  const webSearch = phase2.slice(webSearchStart, voiceStart);

  for (const channel of [
    "webSearch:get",
    "webSearch:existingAuth:get",
    "webSearch:existingAuth:consent",
    "webSearch:existingAuth:revoke",
    "webSearch:setEnabled",
    "webSearch:setSelection",
    "webSearch:setAutomaticRoute",
    "webSearch:setProviderConfig",
    "webSearch:setCredential",
    "webSearch:removeCredential",
  ]) {
    assert.match(webSearch, new RegExp(`ipcMain\\.handle\\(\\s*"${channel}"`, "u"));
  }
  assert.match(phase2, /function webSearchMutationOwner\(/u);
  assert.match(webSearch, /webSearchMutationOwner\(event\)/gu);
  assert.match(webSearch, /isWebSearchProviderId\(/u);
  assert.match(webSearch, /normalizeWebSearchSettings\(/u);
  assert.doesNotMatch(webSearch, /secrets\.getKey\(/u);
  assert.doesNotMatch(webSearch, /keyPrefix|keySuffix|rawError|responseBody|headers/iu);
  assert.doesNotMatch(webSearch, /return\s+key\b/u);
});

test("preload and renderer IPC expose only the generic Web Search contract", async () => {
  const [preloadChannels, rendererIpc, rendererTypes] = await Promise.all([
    source("renderer/preload-channels.ts"),
    source("renderer/lib/ipc.ts"),
    source("renderer/lib/types.ts"),
  ]);
  assert.equal(INVOKE_PREFIXES.includes("webSearch:"), true);
  assert.match(preloadChannels, /"webSearch:"/u);
  for (const channel of [
    "webSearch:get",
    "webSearch:existingAuth:get",
    "webSearch:existingAuth:consent",
    "webSearch:existingAuth:revoke",
    "webSearch:setEnabled",
    "webSearch:setSelection",
    "webSearch:setAutomaticRoute",
    "webSearch:setProviderConfig",
    "webSearch:setCredential",
    "webSearch:removeCredential",
  ]) {
    assert.match(rendererIpc, new RegExp(`"${channel}"`, "u"));
  }
  assert.match(rendererIpc, /export const webSearchApi/u);
  assert.match(rendererIpc, /consentExistingAuth/u);
  assert.match(rendererIpc, /revokeExistingAuth/u);
  assert.match(rendererTypes, /WebSearchRendererSnapshot/u);
  assert.match(rendererTypes, /WebSearchSettingsV2/u);
  assert.doesNotMatch(rendererIpc, /getKey|secretId|keyPrefix|keySuffix/u);
});

test("legacy Exa aliases remain fenced and do not bypass v2 credential access", async () => {
  const phase2 = await source("main/handlers/phase2.ts");
  const exaStart = phase2.indexOf('ipcMain.handle("exa:get"');
  const voiceStart = phase2.indexOf("// ── Voice transcription", exaStart);
  assert.ok(exaStart >= 0);
  assert.ok(voiceStart > exaStart);
  const exa = phase2.slice(exaStart, voiceStart);
  assert.match(exa, /webSearchMutationOwner\(event\)/gu);
  assert.match(exa, /webSearchCredentials\.reference\("exa"/u);
  assert.doesNotMatch(exa, /secrets\.(?:getKey|setKey|deleteKey)\(/u);
  assert.doesNotMatch(exa, /return\s+key\b|return\s+value\b/u);
});

test("the main Web Search binding consumes the closed settings projection", async () => {
  const binding = await source("main/services/web-search-main.ts");
  assert.match(binding, /configStore\.getWebSearchSettings\(\)/u);
  assert.match(binding, /return\s+\{\s*\.\.\.settings,\s*webSearch\s*\}/u);
  assert.doesNotMatch(binding, /persistSettings:\s*\(patch\).*webSearch/u);
});
