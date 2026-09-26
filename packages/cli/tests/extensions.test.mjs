import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const pkgDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const selfcheck = path.join(pkgDir, "dist", "selfcheck.js");

function rmSyncSafe(dir) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best-effort.
	}
}

test("every Aiden extension registers and contributes its tools in a real session", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-ext-"));
	const result = spawnSync(process.execPath, [selfcheck], {
		cwd: path.join(pkgDir, "dist", "app"),
		env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		encoding: "utf-8",
		timeout: 120_000,
	});
	rmSyncSafe(agentDir);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout.trim().split("\n").pop());
	const extensions = report.extensions.map((name) => name.replace(/<inline:|>/g, ""));
	for (const expected of [
		"aiden-advisor",
		"aiden-ask-user-question",
		"aiden-btw",
		"aiden-startup",
		"aiden-context-capture",
		"aiden-display-image",
		"aiden-memory",
		"aiden-todo",
		"aiden-usage",
		"aiden-voice",
		"aiden-web-search",
		"aiden-sessions",
		"aiden-providers",
		"aiden-workflows",
		"aiden-onboarding",
		"aiden-subagents",
		"aiden-artifacts",
		"aiden-mcp",
		"aiden-schedule",
	]) {
		assert.ok(extensions.includes(expected), `extension ${expected} missing; loaded: ${extensions.join(", ")}`);
	}
	assert.deepEqual(report.tools, [
		"advisor",
		"ask_user_question",
		"display_image",
		"recall_memory",
		"remember_fact",
		"render_artifact",
		"schedule_task",
		"subagent",
		"todo",
		"web_search",
	]);
	assert.equal(report.errors, 0, "extension loader reported errors");
});

/**
 * Evaluates a pure module through Node's TypeScript stripping. Only modules
 * whose imports are types or .ts files qualify; feature modules that import
 * Aiden cores with .js specifiers resolve only under esbuild, so their
 * end-to-end coverage lives in the selfcheck test above.
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
const widgetUrl = JSON.stringify(pathToFileURL(path.join(pkgDir, "src", "extensions", "todo-widget.ts")).href);
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

test("todo widget renders statuses and hides when empty", () => {
	const out = evalModule(`
import { renderTodoWidget } from ${widgetUrl};
const empty = renderTodoWidget({ tasks: [], nextId: 1 });
if (empty !== undefined) throw new Error("empty state must hide the widget");
const lines = renderTodoWidget({ tasks: [
	{ id: 1, subject: "Ship", status: "completed", blockedBy: [] },
	{ id: 2, subject: "Build", status: "in_progress", activeForm: "Building", blockedBy: [] },
	{ id: 3, subject: "Wait", status: "pending", blockedBy: [2] },
], nextId: 4 });
if (lines[0] !== "todos 1/3") throw new Error("counter wrong: " + lines[0]);
if (!lines.some((line) => line.includes("✓ Ship"))) throw new Error("completed glyph missing");
if (!lines.some((line) => line.includes("◉ Building…"))) throw new Error("in-progress label missing");
if (!lines.some((line) => line.includes("blocked by 2"))) throw new Error("blocked annotation missing");
console.log("todo-ok");
`);
	assert.match(out, /todo-ok/);
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


const vendoredSources = [
	["src/vendor/advisor/advisor-runtime.ts", "main/services/advisor-runtime.ts"],
	["src/vendor/advisor/advisor-context.ts", "main/services/advisor-context.ts"],
	["src/vendor/advisor/advisor-attempt-store.ts", "main/services/advisor-attempt-store.ts"],
	["src/vendor/advisor/data-store.ts", "main/services/data-store.ts"],
	["src/vendor/advisor/regular-file-read.ts", "main/services/regular-file-read.ts"],
];

function stripImportsAndHeader(source) {
	const withoutHeader = source.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
	return withoutHeader
		.replace(/^\s*import[\s\S]*?from\s*"[^"]*";\s*$/gm, "")
		.replace(/import\("[^"]*"\)/g, "import(DYNAMIC)")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

test("vendored advisor sources stay aligned with the desktop originals", () => {
	for (const [vendored, desktop] of vendoredSources) {
		const vendoredText = stripImportsAndHeader(readFileSync(path.join(pkgDir, vendored), "utf-8"));
		const desktopText = stripImportsAndHeader(readFileSync(path.join(pkgDir, "..", "..", desktop), "utf-8"));
		assert.equal(
			vendoredText,
			desktopText,
			`${vendored} drifted from ${desktop}; re-apply the vendoring (header + specifier rewrites)`,
		);
	}
});
