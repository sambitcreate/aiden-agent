import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("--version answers before the runtime loads", () => {
	const result = runCli(["--version"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "", "the static answer must not load node:sqlite or anything that warns");
});

test("a deleted current folder gets one plain line instead of a crash", { skip: process.platform === "win32" }, () => {
	const parent = mkdtempSync(path.join(tmpdir(), "aiden-deleted-cwd-"));
	const doomed = path.join(parent, "gone");
	mkdirSync(doomed);
	try {
		// The shell enters the folder, removes it, then starts the CLI there.
		const result = spawnSync("/bin/sh", ["-c", 'cd "$1" && rmdir "$1" && exec "$2" "$3" mcp list', "sh", doomed, process.execPath, cli], {
			encoding: "utf-8",
			timeout: 60_000,
			env: { ...process.env, AIDEN_CODING_AGENT_DIR: path.join(parent, "agent") },
		});
		assert.equal(result.status, 1, result.stderr || result.stdout);
		assert.equal(result.stderr.trim(), "aiden: The current folder no longer exists. Change to an existing folder and try again.");
		assert.doesNotMatch(result.stderr, /uv_cwd|at .*\.js:\d+/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
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

test("bare aiden and --help print the command list, serve first", () => {
	for (const args of [[], ["--help"], ["-h"]]) {
		const result = runCli(args);
		assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
		assert.equal(result.stderr, "", args.join(" "));
		const commands = result.stdout.split("\n").filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim().split(/\s/)[0]);
		assert.equal(commands[0], "serve", args.join(" "));
		assert.ok(commands.includes("remote") && commands.includes("auth"), result.stdout);
		for (const removed of ["theme", "reset"]) assert.ok(!commands.includes(removed), `${removed} must not be listed`);
	}
});

test("modes and flags of the removed interactive CLI exit non-zero with one line", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-agent-"));
	try {
		for (const args of [["-p", "hi"], ["--mode", "rpc"], ["--mode", "json", "hi"], ["--list-models"], ["--tui-mode", "fullscreen"], ["--theme", "dark"], ["fix the failing test"], ["theme", "import"], ["reset"]]) {
			const result = runCli(args, { env: { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, input: "" });
			assert.notEqual(result.status, 0, args.join(" "));
			assert.equal(result.stdout, "", args.join(" "));
			assert.equal(result.stderr, "aiden: the interactive CLI was removed; run `aiden serve` or `aiden help`.\n", args.join(" "));
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("aiden app shows and accepts no appearance topic", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-app-"));
	try {
		const env = { ...process.env, AIDEN_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
		const status = runCli(["app", "status"], { env });
		assert.equal(status.status, 0, status.stderr);
		const ids = JSON.parse(status.stdout).flatMap((topic) => topic.rows.map((row) => row.id));
		assert.ok(ids.includes("memory.enabled"), ids.join(", "));
		assert.ok(!ids.some((id) => id.startsWith("appearance.")), ids.join(", "));
		const appearance = runCli(["app", "get", "appearance"], { env });
		assert.equal(appearance.status, 1);
		assert.match(appearance.stderr, /^Usage: aiden app /);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("AIDEN_CODING_AGENT_DIR isolates state (rebranded env override)", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "aiden-cli-agent-"));
	try {
		const result = runCli(["provider", "list"], {
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
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("aiden help names Aiden's MCP commands and no native pi-mcp routing", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}mcp list\|presets\|add\|preset\|login\|logout\|remove /m);
  assert.doesNotMatch(result.stdout, /pi-mcp/);
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

test("bundled ChatGPT OAuth module loads and rejects missing installation identity before networking", async () => {
  const module = await import(pathToFileURL(path.resolve(pkgDir, "dist/app/chunks/openai-chatgpt.js")).href);
  await assert.rejects(module.openaiChatGPTOAuth.login({
    signal: new AbortController().signal,
    prompt: async () => { throw new Error("Unexpected prompt before identity validation"); },
    notify: () => { throw new Error("Unexpected network login before identity validation"); },
  }), /requires a device ID/);
});
