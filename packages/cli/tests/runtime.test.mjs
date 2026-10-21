import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function rpcCommandDetails(args, options) {
	const result = runCli(["--mode", "rpc", "--no-session", ...args], {
		...options,
		input: '{"id":"skills-probe","type":"get_commands"}\n',
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const response = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
		.find((message) => message.type === "response" && message.id === "skills-probe");
	assert.ok(response, `missing correlated get_commands response: ${result.stdout}`);
	assert.equal(response.command, "get_commands");
	assert.equal(response.success, true, JSON.stringify(response));
	return response.data.commands;
}

function rpcCommands(args, options) {
	return rpcCommandDetails(args, options).map((command) => command.name);
}

function makeProbeSkill(root, name, description = "Skill discovery policy probe.") {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nProbe body.\n`);
	return dir;
}

test("--version reports the Aiden CLI version", () => {
	const outer = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
	const result = runCli(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), outer.version);
});

test("--version answers before the runtime loads and agrees with pi's own answer", () => {
	const fast = runCli(["--version"]);
	// A second flag skips the entry's static answer, so pi's main() replies.
	const viaPi = runCli(["--version", "--offline"], { env: { ...process.env, PI_OFFLINE: "1" } });
	assert.equal(viaPi.status, 0, viaPi.stderr);
	assert.equal(fast.stdout, viaPi.stdout);
	assert.equal(fast.stderr, "", "the static answer must not load node:sqlite or anything that warns");
});

test("aiden help lists the Aiden commands", () => {
	const result = runCli(["help"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Aiden commands:/);
	assert.match(result.stdout, /^ {2}workspace /m);
});

test("the SQLite experimental warning is filtered and other warnings are not", () => {
	const filter = pathToFileURL(path.join(pkgDir, "src", "sqlite-warning.ts")).href;
	const script = [
		`import { suppressSqliteExperimentalWarning } from ${JSON.stringify(filter)};`,
		"suppressSqliteExperimentalWarning();",
		"await import('node:sqlite');",
		"process.emitWarning('Probe feature is experimental', 'ExperimentalWarning');",
		"process.emitWarning('SQLite probe without a type');",
	].join("\n");
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
		encoding: "utf-8",
		timeout: 60_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
	assert.match(result.stderr, /ExperimentalWarning: Probe feature is experimental/);
	assert.match(result.stderr, /Warning: SQLite probe without a type/);
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
	assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
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
		assert.equal(result.status, 0, result.stderr);
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

test("built CLI keeps native and explicit skills ahead of same-name automatic skills", () => {
	const root = mkdtempSync(path.join(tmpdir(), "aiden-cli-skill-collision-"));
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const project = path.join(root, "project");
	for (const dir of [home, agentDir, project]) mkdirSync(dir);
	makeProbeSkill(path.join(home, ".aiden", "skills"), "native-collision", "Automatic native collision probe.");
	makeProbeSkill(path.join(agentDir, "skills"), "native-collision", "Native agent skill wins.");
	makeProbeSkill(path.join(home, ".aiden", "skills"), "explicit-collision", "Automatic explicit collision probe.");
	const explicitPath = makeProbeSkill(path.join(root, "explicit"), "explicit-collision", "User explicit skill wins.");
	const options = { cwd: project, env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
	const skill = (details, name) => details.find((command) => command.name === `skill:${name}`);
	try {
		const details = rpcCommandDetails(["--skill", explicitPath], options);
		assert.equal(skill(details, "native-collision")?.description, "Native agent skill wins.");
		assert.equal(skill(details, "explicit-collision")?.description, "User explicit skill wins.");
		assert.equal(skill(details, "explicit-collision")?.sourceInfo?.path, path.join(explicitPath, "SKILL.md"));
		const disabled = rpcCommandDetails(["--no-skills", "--skill", explicitPath], options);
		assert.equal(skill(disabled, "explicit-collision")?.description, "User explicit skill wins.");
		assert.equal(skill(disabled, "native-collision"), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("built CLI applies skill disable and project trust before automatic discovery", () => {
	const root = mkdtempSync(path.join(tmpdir(), "aiden-cli-skill-policy-"));
	const home = path.join(root, "home");
	const project = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	mkdirSync(home);
	mkdirSync(project);
	mkdirSync(agentDir);
	const global = "global-probe";
	const projectName = "untrusted-probe";
	const explicit = "explicit-probe";
	makeProbeSkill(path.join(home, ".aiden", "skills"), global);
	makeProbeSkill(path.join(home, ".claude", "skills"), "global-claude-probe");
	makeProbeSkill(path.join(project, ".claude", "skills"), projectName);
	const explicitPath = makeProbeSkill(path.join(root, "explicit"), explicit);
	const env = { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	const commands = (flags = []) => rpcCommands(flags, { cwd: project, env });
	const has = (list, name) => list.includes(`skill:${name}`);
	const trustPath = path.join(agentDir, "trust.json");
	try {
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
		const initialDetails = rpcCommandDetails([], { cwd: project, env });
		let found = initialDetails.map((command) => command.name);
		assert.equal(has(found, global), true);
		assert.equal(has(found, "global-claude-probe"), true);
		assert.equal(has(found, projectName), false, "a .claude-only project must require trust");
		assert.equal(initialDetails.find((command) => command.name === `skill:${global}`)?.sourceInfo?.scope, "user");

		for (const flag of ["--no-approve", "-na"]) {
			found = commands([flag]);
			assert.equal(has(found, global), true, `${flag} must retain global skills`);
			assert.equal(has(found, projectName), false, `${flag} must refuse project skills`);
		}
		for (const flag of ["--no-skills", "-ns"]) {
			found = commands([flag]);
			for (const name of [global, "global-claude-probe", projectName]) {
				assert.equal(has(found, name), false, `${flag} must disable automatic ${name}`);
			}
		}
		found = commands(["--no-skills", "--no-approve"]);
		assert.equal(has(found, projectName), false);
		assert.equal(has(found, global), false);

		const approvedDetails = rpcCommandDetails(["--approve"], { cwd: project, env });
		found = approvedDetails.map((command) => command.name);
		assert.equal(has(found, projectName), true, "explicit project approval must admit discovery");
		assert.equal(approvedDetails.find((command) => command.name === `skill:${projectName}`)?.sourceInfo?.scope, "project");
		writeFileSync(trustPath, JSON.stringify({ [realpathSync(project)]: false }));
		assert.equal(has(commands([]), projectName), false, "saved denial must win");
		writeFileSync(trustPath, JSON.stringify({ [realpathSync(project)]: true }));
		assert.equal(has(commands([]), projectName), true, "saved approval must admit discovery");
		assert.equal(has(commands(["--no-approve"]), projectName), false, "explicit denial must override saved approval");

		found = commands(["--no-skills", "--no-approve", "--skill", explicitPath]);
		assert.equal(has(found, explicit), true, "only the user's explicit skill path survives refusal flags");
		for (const name of [global, "global-claude-probe", projectName]) {
			assert.equal(has(found, name), false, `${name} was discovered despite refusal flags`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resumed session discovers skills from its cwd instead of the launch cwd", () => {
	const root = mkdtempSync(path.join(tmpdir(), "aiden-cli-skill-switch-"));
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const first = path.join(root, "first");
	const second = path.join(root, "second");
	for (const dir of [home, agentDir, first, second]) mkdirSync(dir);
	makeProbeSkill(path.join(first, ".claude", "skills"), "first-project-probe");
	makeProbeSkill(path.join(second, ".claude", "skills"), "second-project-probe");
	const sessionPath = path.join(root, "other-session.jsonl");
	writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: second }) + "\n");
	try {
		const result = runCli(["--mode", "rpc", "--session", sessionPath, "--approve"], {
			cwd: first,
			env: { ...process.env, HOME: home, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			input: '{"id":"resumed","type":"get_commands"}\n',
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const response = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
			.find((message) => message.type === "response" && message.id === "resumed");
		assert.ok(response, `missing correlated get_commands response: ${result.stdout}`);
		assert.equal(response.command, "get_commands");
		assert.equal(response.success, true, JSON.stringify(response));
		const names = response.data.commands.map((command) => command.name);
		assert.ok(names.includes("skill:second-project-probe"));
		assert.ok(!names.includes("skill:first-project-probe"));
	} finally {
		rmSync(root, { recursive: true, force: true });
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
		for (const expected of ["usage", "voice", "dictate", "btw", "mcp"]) {
			assert.ok(commands.includes(expected), `/${expected} missing over RPC; got: ${commands.join(", ")}`);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("/dictate settles and clears its status when the recorder exits early or is missing", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(path.join(tmpdir(), "aiden-cli-dictate-"));
	try {
		const agentDir = path.join(root, "agent"), bin = path.join(root, "bin");
		mkdirSync(agentDir); mkdirSync(bin);
		writeFileSync(path.join(agentDir, "aiden.json"), JSON.stringify({ voice: { provider: "gemini" } }));
		// A recorder that exits immediately without producing audio (no microphone permission, device busy).
		writeFileSync(path.join(bin, "rec"), "#!/bin/sh\nexit 0\n"); chmodSync(path.join(bin, "rec"), 0o755);
		const voiceUrl = JSON.stringify(pathToFileURL(path.join(pkgDir, "src", "extensions", "voice.ts")).href);
		const script = `
import { createVoiceInlineExtension } from ${voiceUrl};
const unhandled = []; process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
const commands = new Map();
createVoiceInlineExtension({ agentDir: ${JSON.stringify(agentDir)} }).factory({ registerCommand: (name, command) => commands.set(name, command), on: () => {} });
async function dictate() {
	const notes = [], statuses = {}; let dismissed = false;
	const ctx = { mode: "tui", ui: {
		setStatus: (key, value) => { statuses[key] = value; },
		notify: (message, level) => notes.push(level + ": " + message),
		// The user presses Enter after 300 ms unless the extension dismisses the prompt first.
		input: (_title, _placeholder, opts) => new Promise((resolve) => {
			const timer = setTimeout(() => resolve(""), 300);
			opts?.signal?.addEventListener("abort", () => { clearTimeout(timer); dismissed = true; resolve(undefined); });
		}),
		pasteToEditor: () => {},
	} };
	await Promise.race([
		commands.get("dictate").handler("", ctx),
		new Promise((_, reject) => setTimeout(() => reject(new Error("/dictate hung")), 5_000)),
	]);
	return { notes, status: statuses["aiden-dictate"], dismissed };
}
process.env.PATH = ${JSON.stringify(bin)} + ":/usr/bin:/bin";
const early = await dictate();
process.env.PATH = "/usr/bin:/bin";
const missing = await dictate();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(JSON.stringify({ early, missing, unhandled }));
`;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--no-warnings", "-e", script], {
			encoding: "utf-8", timeout: 60_000,
			env: { ...process.env, GEMINI_API_KEY: "test-key", AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		});
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout.trim().split("\n").pop());
		assert.deepEqual(report.unhandled, []);
		assert.ok(report.early.notes.some((note) => note.startsWith("error: Dictation failed:")), JSON.stringify(report.early));
		assert.equal(report.early.status, undefined, "status must be cleared after an early recorder exit");
		assert.equal(report.early.dismissed, true, "the prompt is dismissed once the recorder stops");
		assert.ok(report.missing.notes.some((note) => note.includes("No audio recorder found")), JSON.stringify(report.missing));
		assert.equal(report.missing.status, undefined);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("aiden help names Aiden's MCP commands and no native pi-mcp routing", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}mcp list\|presets\|add\|preset\|login\|logout\|remove /m);
  assert.doesNotMatch(result.stdout, /pi-mcp/);
});

test("Pi's built-in MCP extension stays off: /mcp is Aiden's and native mcp.json servers never start", { skip: process.platform === "win32" }, async () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-native-mcp-"));
  try {
    const marker = path.join(agentDir, "native-server-started");
    // A server in Pi's native configuration that records being launched.
    writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: {
      command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);`],
    } } }));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session"], {
      env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.write('{"id":"mcp-probe","type":"get_commands"}\n');
    // Long enough for a native connection to have spawned its server.
    const deadline = Date.now() + 30_000;
    while (!stdout.includes('"mcp-probe"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    child.stdin.end();
    await exited;
    const response = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === "mcp-probe");
    assert.ok(response?.success, stdout);
    const mcp = response.data.commands.filter((command) => command.name === "mcp");
    assert.equal(mcp.length, 1, JSON.stringify(mcp));
    assert.match(JSON.stringify(mcp[0].sourceInfo), /aiden-mcp/u, "/mcp must come from Aiden's extension");
    assert.equal(existsSync(marker), false, "a native mcp.json server was started");
    assert.doesNotMatch(stderr, /was not loaded|builtin:mcp/u, "turning Pi's MCP off must not print a replacement diagnostic");
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("a malformed or unreadable native mcp.json never blocks the CLI", () => {
  const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-mcp-"));
  try {
    const legacy = path.join(agentDir, "mcp.json");
    const options = { env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } };
    writeFileSync(legacy, "{ not json");
    const malformed = runCli(["mcp", "list"], options);
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.deepEqual(JSON.parse(malformed.stdout), []);
    assert.match(malformed.stderr, /skipped MCP migration; .* is not valid JSON/);
    assert.equal(readFileSync(legacy, "utf8"), "{ not json");
    if (process.getuid?.() !== 0) {
      writeFileSync(legacy, JSON.stringify([{ id: "old", name: "Old", enabled: false, transport: "stdio", command: "example" }]));
      chmodSync(legacy, 0o000);
      const unreadable = runCli(["mcp", "list"], options);
      chmodSync(legacy, 0o600);
      assert.equal(unreadable.status, 0, unreadable.stderr);
      assert.match(unreadable.stderr, /skipped MCP migration; .* is unreadable \(EACCES\)/);
    }
  } finally { rmSync(agentDir, { recursive: true, force: true }); }
});

for (const revoke of [false, true]) {
  test(`bundled codemode executes nested tools with current workspace authority (revoke=${revoke})`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "aiden-cli-codemode-"));
    const agentDir = path.join(root, "agent"), workspace = path.join(root, "workspace");
    mkdirSync(agentDir); mkdirSync(workspace);
    try {
      writeFileSync(path.join(agentDir, "workspaces.json"), JSON.stringify([{ id: "fixture", name: "Fixture", folderPath: realpathSync(workspace), access: "full" }]));
      const result = runCli(["--mode", "json", "--no-session", "--tools", "codemode,write,fixture_revoke", "-e",
        path.resolve(pkgDir, "tests/fixtures/codemode-provider.mjs"), "--model", "offline-fixture/fixture", "Exercise codemode"], {
        cwd: workspace,
        env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", AIDEN_TEST_REVOKE: revoke ? "1" : "0" },
      });
      assert.equal(result.status, 0, result.stderr);
      const events = result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      const nested = events.find((event) => event.type === "tool_execution_end" && event.toolName === "write" && event.parentToolCallId === "codemode-fixture");
      assert.ok(nested, result.stderr + JSON.stringify(events.filter((event) => event.type.startsWith("tool_execution"))));
      assert.equal(nested.isError, revoke, JSON.stringify(nested));
      const file = path.join(workspace, "codemode-result.txt");
      if (revoke) {
        assert.equal(existsSync(file), false, "revoked nested write must have no filesystem effect");
        assert.match(JSON.stringify(nested), /Workspace tool access is disabled/);
      } else assert.equal(readFileSync(file, "utf8"), "worker executed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("bundled ChatGPT OAuth module loads and rejects missing installation identity before networking", async () => {
  const module = await import(pathToFileURL(path.resolve(pkgDir, "dist/app/chunks/openai-chatgpt.js")).href);
  await assert.rejects(module.openaiChatGPTOAuth.login({
    signal: new AbortController().signal,
    prompt: async () => { throw new Error("Unexpected prompt before identity validation"); },
    notify: () => { throw new Error("Unexpected network login before identity validation"); },
  }), /requires a device ID/);
});
