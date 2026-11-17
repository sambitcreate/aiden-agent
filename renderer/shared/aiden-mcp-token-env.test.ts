import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { aidenMcpTokenEnvName } from "./aiden-mcp-token-env.js";

const APPS = [
  { id: "device_k3j9qxa1", name: "Claude Code", token: "first-token" },
  { id: "device_p7qd2mb2", name: "Claude Code", token: "second-token" },
  { id: "device_zz81aa03", name: "🤖 Codex — work laptop, the long one", token: "third-token" },
  { id: "device_9x", name: "!!!", token: "fourth-token" },
];

test("each app's token variable is a shell name that only that app's export sets", () => {
  // A real shell is the oracle: every name must be assignable, and exporting
  // all four apps' tokens in one profile must leave each app's own token readable.
  const script = [
    ...APPS.map((app) => `export ${aidenMcpTokenEnvName(app)}='${app.token}'`),
    ...APPS.map((app) => `printf '%s\\n' "$${aidenMcpTokenEnvName(app)}"`),
  ].join("\n");
  const output = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.deepEqual(output.trim().split("\n"), APPS.map((app) => app.token));
});

test("the variable name tells the person which app's token it holds", () => {
  assert.match(aidenMcpTokenEnvName({ id: "device_k3j9qxa1", name: "Claude Code" }), /^AIDEN_MCP_TOKEN_CLAUDE_CODE_K3J9QX$/u);
  assert.match(aidenMcpTokenEnvName({ id: "device_p7qd2mb2", name: "Codex" }), /^AIDEN_MCP_TOKEN_CODEX_P7QD2M$/u);
});
