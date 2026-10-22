/* global structuredClone */

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseUnifiedPatch, patchPiAiToolCache } from "./patch-pi-ai-tool-cache.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installedPiAi = path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-ai");
const patchFile = path.join(repositoryRoot, "patches", "pi-ai-1.3.0-responses-tool-cache.patch");

// The copy lives under the repository's node_modules so pi-ai's own
// dependencies (openai, typebox, ...) still resolve from the root install.
async function pristineCopy(t) {
  const cacheRoot = path.join(repositoryRoot, "node_modules", ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const root = await mkdtemp(path.join(cacheRoot, "aiden-pi-ai-tool-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "pi-ai");
  await cp(path.join(installedPiAi, "package.json"), path.join(packageRoot, "package.json"));
  await cp(path.join(installedPiAi, "dist"), path.join(packageRoot, "dist"), { recursive: true });
  // postinstall may already have patched the root install; undo it so every test
  // starts from the published 1.3.0 files.
  for (const file of parseUnifiedPatch(await readFile(patchFile, "utf8"))) {
    const filePath = path.join(packageRoot, file.path);
    let source = await readFile(filePath, "utf8");
    for (const { before, after } of file.hunks) {
      if (source.includes(after) && !source.includes(before)) source = source.replace(after, () => before);
    }
    await writeFile(filePath, source);
  }
  return packageRoot;
}

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} } });

const additionalToolsModel = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://127.0.0.1:9",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
  compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
};

// Sends one request after each step of a chat whose tool set loses a tool and
// then gains two, and returns the request payloads the provider would receive.
async function requestsAcrossToolChanges(packageRoot) {
  const { streamSimple } = await import(pathToFileURL(path.join(packageRoot, "dist", "compat.js")).href);
  const messages = [{ role: "system", content: "base prompt", toolsAdded: [tool("base_tool"), tool("drop_tool")], timestamp: 0 }];
  const steps = [
    [{ role: "user", content: "first", timestamp: 1 }],
    [
      { role: "system", content: "", toolsRemoved: [{ name: "drop_tool" }], timestamp: 2 },
      { role: "user", content: "after removal", timestamp: 3 },
    ],
    [
      { role: "system", content: "", toolsAdded: [tool("late_tool")], timestamp: 4 },
      { role: "user", content: "after first load", timestamp: 5 },
    ],
    [
      { role: "system", content: "", toolsAdded: [tool("later_tool")], timestamp: 6 },
      { role: "user", content: "after second load", timestamp: 7 },
    ],
  ];
  const payloads = [];
  for (const step of steps) {
    messages.push(...step);
    let captured;
    const stream = streamSimple(additionalToolsModel, { messages: [...messages] }, {
      apiKey: "test-key",
      onPayload: (payload) => {
        captured = structuredClone(payload);
        throw new Error("payload captured");
      },
    });
    await stream.result();
    assert.ok(captured, "expected a request payload");
    payloads.push(captured);
  }
  return payloads;
}

// A provider prompt cache only hits when the tools and the earlier input are unchanged.
function keepsCachedPrefix(payloads) {
  return payloads.every((payload, index) => {
    if (index === 0) return true;
    const previous = payloads[index - 1];
    return (
      JSON.stringify(payload.tools ?? []) === JSON.stringify(previous.tools ?? []) &&
      JSON.stringify(payload.input.slice(0, previous.input.length)) === JSON.stringify(previous.input)
    );
  });
}

test("keeps the OpenAI Responses request prefix stable across tool removal and later loads", async (t) => {
  const packageRoot = await pristineCopy(t);
  assert.equal(keepsCachedPrefix(await requestsAcrossToolChanges(packageRoot)), false, "pristine 1.3.0 should rewrite the prefix");

  assert.deepEqual(await patchPiAiToolCache(repositoryRoot, packageRoot), { changed: true });
  assert.deepEqual(await patchPiAiToolCache(repositoryRoot, packageRoot), { changed: false });

  // Fresh module instance: import the patched files under a new URL.
  const patchedRoot = path.join(path.dirname(packageRoot), "pi-ai-patched");
  await cp(packageRoot, patchedRoot, { recursive: true });
  const payloads = await requestsAcrossToolChanges(patchedRoot);
  assert.equal(keepsCachedPrefix(payloads), true);
  const last = payloads.at(-1);
  assert.ok(last.input.some((item) => item.content?.includes("no longer available. Do not call them:\n- drop_tool")));
  assert.ok(last.input.some((item) => item.content?.includes("Still unavailable: drop_tool.")));
});

test("fails closed on another pi-ai version", async (t) => {
  const packageRoot = await pristineCopy(t);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  await writeFile(packageJsonPath, JSON.stringify({ ...packageJson, version: "1.4.0" }));
  await assert.rejects(patchPiAiToolCache(repositoryRoot, packageRoot), /Expected @earendil-works\/pi-ai 1\.3\.0/u);
});

test("leaves every file untouched when one upstream hunk drifts", async (t) => {
  const packageRoot = await pristineCopy(t);
  const transcriptPath = path.join(packageRoot, "dist", "utils", "transcript.js");
  const sharedPath = path.join(packageRoot, "dist", "api", "openai-responses-shared.js");
  const sharedBefore = await readFile(sharedPath, "utf8");
  const transcript = await readFile(transcriptPath, "utf8");
  await writeFile(transcriptPath, transcript.replace("const anchorsAdditions =", "const anchorsAdditionsDrifted ="));
  await assert.rejects(patchPiAiToolCache(repositoryRoot, packageRoot), /utils\/transcript\.js hunk 1 changed unexpectedly/u);
  assert.equal(await readFile(sharedPath, "utf8"), sharedBefore);
});

test("reads hunk bodies by their header counts", () => {
  const [file] = parseUnifiedPatch(
    ["--- a/x.js", "+++ b/x.js", "@@ -1,4 +1,4 @@", " a", "--- b", "+++ B", "", "-c", "+C", "after"].join("\n").replace("\n\n", "\n \n"),
  );
  assert.equal(file.path, "x.js");
  assert.deepEqual(file.hunks, [{ before: "a\n-- b\n\nc", after: "a\n++ B\n\nC" }]);
  assert.throws(() => parseUnifiedPatch(["+++ b/x.js", "@@ -1,2 +1,2 @@", " a"].join("\n")), /truncated/u);
});
