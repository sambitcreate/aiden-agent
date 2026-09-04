import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settings = readFileSync(new URL("./memory-settings.tsx", import.meta.url), "utf8");
const chatPane = readFileSync(new URL("../../main/chat-pane.tsx", import.meta.url), "utf8");

test("Memory settings expose authoritative global and workspace switches", () => {
  assert.match(settings, /aria-label="Use memory globally"/u);
  assert.match(settings, /workspacesApi\.update\(workspace\.id, \{ memoryEnabled: enabled \}\)/u);
  assert.match(settings, /Existing approved[\s\S]*stay on this Mac/u);
  assert.match(settings, /Bot memory has its own scope/u);
});

test("the chat toolbar no longer exposes the manual memory manager", () => {
  assert.doesNotMatch(chatPane, /MemoryDialog|memoryOpen|Open memory|BrainCircuit/u);
});

test("automatic compaction is independently persisted and describes one-time commands", () => {
  assert.match(settings, /settingsApi\.set\(\{ compactionEngine: engine \}\)/u);
  assert.match(settings, /aria-label="Automatic compaction engine"/u);
  assert.match(settings, /focus-visible:ring-focus-ring/u);
  assert.match(settings, /orientation="vertical"/u);
  assert.match(settings, /pi-vcc Compaction — Experimental/u);
  assert.match(settings, /\/compact-LLM or \/compact-VCC/u);
  assert.match(settings, /Current-chat recall works independently of memory/u);
});
