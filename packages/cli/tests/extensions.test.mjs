import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const pkgDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";

/**
 * Evaluates a pure module through Node's TypeScript stripping. Only modules
 * whose imports are types or .ts files qualify; feature modules that import
 * Aiden cores with .js specifiers resolve only under esbuild, so their
 * end-to-end coverage lives in the parity suite's daemon tests.
 */
function evalModule(expression) {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "--no-warnings", "-e", expression],
		{ cwd: pkgDir, encoding: "utf-8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

const bridgeUrl = JSON.stringify(pathToFileURL(path.join(pkgDir, "src", "pi-bridge", "adapt-aiden-extension.ts")).href);
const settingsUrl = JSON.stringify(pathToFileURL(path.join(pkgDir, "src", "extensions", "aiden-settings.ts")).href);

test("bridge registers tools and chains system prompts onto before_agent_start", () => {
	const out = evalModule(`
import * as bridge from ${bridgeUrl};
const registered = [];
const handlers = {};
const fakePi = {
	registerTool: (tool) => registered.push(tool.name),
	on: (event, handler) => { handlers[event] = handler; },
};
const inline = bridge.aidenExtensionToInlineFactory("aiden-demo", {
	id: "aiden.demo",
	systemPrompt: "Use the demo tool politely.",
	tools: [{ name: "demo_tool", execute: async () => ({ content: [], details: null }) }],
});
inline.factory(fakePi);
if (registered.join(",") !== "demo_tool") throw new Error("tool not registered: " + registered);
const result = await handlers.before_agent_start({ systemPrompt: "BASE" }, {});
if (result.systemPrompt !== "BASE\\n\\nUse the demo tool politely.") {
	throw new Error("prompt chain wrong: " + JSON.stringify(result));
}
console.log("bridge-ok");
`);
	assert.match(out, /bridge-ok/);
});

test("aiden.json settings reject wrong-typed values (desktop normalization parity)", () => {
	const out = evalModule(`
import { readAidenSettings, writeAidenSettings } from ${settingsUrl};
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "aiden-cli-set-"));
try {
	// Wrong-typed memoryEnabled (string like a hand-edited file) is ignored:
	// memory stays enabled, matching the desktop's strict-shape normalization.
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ memoryEnabled: "false" }));
	if (readAidenSettings(dir).memoryEnabled !== undefined) throw new Error("string memoryEnabled must be ignored");
	// Unknown voice provider ("local" is desktop-only) normalizes away.
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ voice: { provider: "local" } }));
	if (readAidenSettings(dir).voice !== undefined) throw new Error("unknown voice provider must be ignored");
	// Non-object voice is ignored.
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ voice: "gemini" }));
	if (readAidenSettings(dir).voice !== undefined) throw new Error("non-object voice must be ignored");
	// Valid provider keeps optional model/language strings only.
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ voice: { provider: "gemini", model: 42, language: "en-US" } }));
	const voice = readAidenSettings(dir).voice;
	if (voice?.provider !== "gemini" || voice?.model !== undefined || voice?.language !== "en-US") {
		throw new Error("voice normalization wrong: " + JSON.stringify(voice));
	}
	console.log("normalize-ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
`);
	assert.match(out, /normalize-ok/);
});

test("memory scope id matches the desktop SAFE_ID charset and is stable per folder", () => {
	const out = evalModule(`
import { workspaceScopeId, memoryEnabledFor } from ${JSON.stringify(
		pathToFileURL(path.join(pkgDir, "src", "extensions", "memory-scope.ts")).href,
	)};
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const a = workspaceScopeId("/tmp/some workspace");
const b = workspaceScopeId("/tmp/some workspace");
const c = workspaceScopeId("/tmp/other");
if (a !== b) throw new Error("scope id must be stable per folder");
if (a === c) throw new Error("different folders must differ");
// Desktop SAFE_ID charset: /^[A-Za-z0-9._:-]{1,160}$/
if (!/^[A-Za-z0-9._:-]{1,160}$/.test(a)) throw new Error("scope id outside SAFE_ID charset: " + a);
const dir = mkdtempSync(path.join(tmpdir(), "aiden-cli-mem-"));
try {
	if (memoryEnabledFor(dir) !== true) throw new Error("memory must default on");
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ memoryEnabled: false }));
	if (memoryEnabledFor(dir) !== false) throw new Error("memoryEnabled: false must disable memory");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("scope-ok");
`);
	assert.match(out, /scope-ok/);
});

test("aiden.json settings preserve other features and reject corrupt authority state", () => {
	const out = evalModule(`
import { readAidenSettings, writeAidenSettings } from ${settingsUrl};
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "aiden-cli-set-"));
try {
	if (readAidenSettings(dir).memoryEnabled !== undefined) throw new Error("defaults must be absent");
	if (readAidenSettings(dir).voice !== undefined) throw new Error("voice must default to absent");
	writeAidenSettings(dir, { memoryEnabled: false, voice: { provider: "gemini" } });
	const read = readAidenSettings(dir);
	if (read.memoryEnabled !== false || read.voice?.provider !== "gemini") throw new Error("roundtrip failed");
	writeFileSync(path.join(dir, "aiden.json"), JSON.stringify({ scheduledTasksEnabled: false, memoryEnabled: true }));
	writeAidenSettings(dir, { memoryEnabled: false });
	if (JSON.parse(readFileSync(path.join(dir, "aiden.json"), "utf8")).scheduledTasksEnabled !== false) throw new Error("lost scheduler setting");
	writeFileSync(path.join(dir, "aiden.json"), "{not json");
	let rejected = false;
	try { readAidenSettings(dir); } catch { rejected = true; }
	if (!rejected) throw new Error("corrupt settings must reject");
	console.log("settings-ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
`);
	assert.match(out, /settings-ok/);
});
