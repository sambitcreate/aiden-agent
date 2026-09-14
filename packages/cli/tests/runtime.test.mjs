import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const pkgDir = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const cli = path.join(pkgDir, "dist", "app", "cli.js");

function runCli(args, options = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf-8",
		timeout: 60_000,
		...options,
	});
}

test("--version reports the Aiden CLI version", () => {
	const outer = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
	const result = runCli(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), outer.version);
});

test("--help brands the CLI as aiden", () => {
	const result = runCli(["--help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^aiden - /m);
	assert.match(result.stdout, /Usage:\n {2}aiden /);
});

test("AIDEN_CODING_AGENT_DIR isolates state (rebranded env override)", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-agent-"));
	const result = runCli(["--list-models"], {
		env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});
	assert.equal(result.status, 0, result.stderr);
	// The agent dir being populated proves the rebranded env var redirected
	// state away from ~/.pi and ~/.aiden.
	assert.ok(existsSync(path.join(agentDir, "auth.json")), "auth.json must land in the agent dir");
	assert.ok(
		existsSync(path.join(agentDir, "models-store.json")),
		"models-store.json must land in the agent dir",
	);
});

test("print mode resolves a default model offline and fails only on credentials", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-agent-"));
	const result = runCli(["-p", "hello"], {
		env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	});
	// Without any provider credential the run must stop at auth, not at model
	// resolution or theme/setup failures.
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /No API key found|No models available/);
});

test("rpc mode answers get_state with a correlated response", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-agent-"));
	const result = runCli(["--mode", "rpc", "--no-session"], {
		env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		input: '{"id":"t-1","type":"get_state"}\n',
	});
	assert.equal(result.status, 0, result.stderr);
	const response = result.stdout
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line))
		.find((message) => message.type === "response" && message.id === "t-1");
	assert.ok(response, "expected a response correlated to request id t-1");
	assert.equal(response.command, "get_state");
	assert.equal(response.success, true);
});

/**
 *. Evaluates shouldDefaultToFullscreenTui by importing the pure src/tui-default.ts
 * module with Node.s TypeScript stripping (pure: no extension imports).
 * invocations, so importing it has no side effects.
 */
function fullscreenDefault(args, settingsPaths) {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`import { shouldDefaultToFullscreenTui } from ${JSON.stringify(
				pathToFileURL(path.join(pkgDir, "src", "tui-default.ts")).href,
			)}; process.stdout.write(String(shouldDefaultToFullscreenTui(${JSON.stringify(args)}, ${JSON.stringify(
				settingsPaths,
			)})));`,
		],
		{ cwd: pkgDir, encoding: "utf-8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout === "true";
}

test("fullscreen TUI is the default unless overridden by flag or saved setting", () => {
	assert.equal(fullscreenDefault([], []), true, "fresh installs default to fullscreen");
	assert.equal(
		fullscreenDefault(["--tui-mode", "regular"], []),
		false,
		"explicit --tui-mode flag wins over the default",
	);
	const dir = mkdtempSync(path.join(tmpdir(), "aiden-cli-tui-"));
	const settings = path.join(dir, "settings.json");
	writeFileSync(settings, JSON.stringify({ tuiMode: "regular" }));
	assert.equal(
		fullscreenDefault([], [settings]),
		false,
		"a saved tuiMode preference (e.g. changed in /config) wins over the default",
	);
	writeFileSync(settings, JSON.stringify({ theme: "slate-dark" }));
	assert.equal(
		fullscreenDefault([], [settings]),
		true,
		"settings without a tuiMode key still get the fullscreen default",
	);
});


test("desktop skills folders (~/.aiden/skills priority set) feed CLI commands", () => {
	const home = mkdtempSync(path.join(tmpdir(), "aiden-cli-home-"));
	try {
		const skillDir = path.join(home, ".aiden", "skills", "injection-probe");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			path.join(skillDir, "SKILL.md"),
			"---\nname: injection-probe\ndescription: Probes desktop skills folder injection.\n---\nProbe body.\n",
		);
		const result = runCli(["--mode", "rpc", "--no-session"], {
			env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: path.join(home, "agent"), PI_OFFLINE: "1" },
			input: '{"id":"c1","type":"get_commands"}\n',
			cwd: home,
		});
		const commands = result.stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line))
			.filter((message) => message.type === "response" && message.command === "get_commands")
			.flatMap((message) => message.data.commands.map((command) => command.name));
		assert.ok(commands.includes("skill:injection-probe"), `injected skill missing from: ${commands.join(", ")}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});


test("Aiden commands are available over the RPC (GUI-interop) surface", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-cmds-"));
	try {
		const result = runCli(["--mode", "rpc", "--no-session"], {
			env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			input: '{"id":"c2","type":"get_commands"}\n',
		});
		const commands = result.stdout
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line))
			.filter((message) => message.type === "response" && message.command === "get_commands")
			.flatMap((message) => message.data.commands.map((command) => command.name));
		for (const expected of ["usage", "voice", "dictate", "btw"]) {
			assert.ok(commands.includes(expected), `/${expected} missing over RPC; got: ${commands.join(", ")}`);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
