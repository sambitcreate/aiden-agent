import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveReviewedMcpLaunch, mcpLaunchReviewText, type McpLaunchReviewDependencies } from "./mcp-launch-review-core.js";
import { mcpStdioLaunchFingerprint, planMcpFieldSecrets, stageMcpFieldSecrets, resolveMcpFieldSecrets } from "./mcp-field-secrets-core.js";
import { createMcpStdioApprovalStore } from "./mcp-stdio-approvals.js";
import { resolveMcpConnectionCredentials } from "./mcp-connection-credentials.js";
import type { McpServer } from "./types.js";

const plain: McpServer = { id: "pending", name: "Pending", enabled: true, transport: "stdio", command: "node", args: ["server.js"], env: { NODE_OPTIONS: "--require /tmp/fixture.js", PATH: "/test/bin", TOKEN: "TEST_PRIVATE_VALUE" } };

async function fixture(t: test.TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-mcp-review-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // Distinct markers, as the real random source provides.
  let next = 0;
  const unique = planMcpFieldSecrets(plain, () => (++next).toString(16).padStart(32, "0"));
  const record = stageMcpFieldSecrets(undefined, unique, { random: () => "f".repeat(32) }).record!;
  let current = unique.server;
  const file = path.join(dir, "config.json"); await fs.writeFile(file, JSON.stringify(current), { mode: 0o600 });
  const approvals = createMcpStdioApprovalStore(async () => path.join(dir, "approvals.json"));
  const reviewed: McpServer[] = [];
  const deps: McpLaunchReviewDependencies = {
    seal: async () => {}, configured: async () => current,
    resolve: async (server) => resolveMcpFieldSecrets(server, record),
    confirm: async (effective) => { reviewed.push(effective); return true; },
    approve: (server, shown) => approvals.approveShown(server, shown), isCurrent: () => true,
  };
  return { deps, approvals, reviewed, sealed: unique.server, file, setCurrent: (server: McpServer) => { current = server; } };
}

test("pending env is absent from durable config, stays unapproved, and explicit review sees the exact effective launch", async (t) => {
  const f = await fixture(t);
  const bytes = await fs.readFile(f.file, "utf8");
  assert.equal(bytes.includes("TEST_PRIVATE_VALUE"), false);
  assert.equal(bytes.includes("--require /tmp/fixture.js"), false);
  assert.equal(await f.approvals.isApproved(f.sealed), false);
  assert.equal(await approveReviewedMcpLaunch(plain.id, mcpStdioLaunchFingerprint(f.sealed), f.deps), true);
  assert.deepEqual(f.reviewed[0]!.env, plain.env);
  assert.equal(await f.approvals.isApproved(f.sealed), true);
  assert.equal(await f.approvals.isApproved({ ...f.sealed, command: "other" }), false);
});

test("failed secret staging/publication, missing values and unresolved plaintext cannot grant launch", async (t) => {
  for (const failure of ["stage", "publish", "missing", "plaintext"] as const) {
    const f = await fixture(t);
    if (failure === "stage" || failure === "publish") f.deps.seal = async () => { throw new Error(`${failure} failed`); };
    if (failure === "missing") f.deps.resolve = async () => { throw new Error("saved value missing"); };
    if (failure === "plaintext") f.setCurrent(plain);
    const shown = mcpStdioLaunchFingerprint(failure === "plaintext" ? plain : f.sealed);
    await assert.rejects(approveReviewedMcpLaunch(plain.id, shown, f.deps), /failed|missing|secure storage/u);
    assert.deepEqual(f.reviewed, []);
    assert.equal(await f.approvals.isApproved(f.sealed), false);
    assert.equal((await fs.readFile(f.file, "utf8")).includes("TEST_PRIVATE_VALUE"), false);
  }
});

test("config, effective secret, document changes or cancellation during review never approve a stale launch", async (t) => {
  for (const change of ["command", "effective-env", "document", "cancel"] as const) {
    const f = await fixture(t);
    f.deps.confirm = async () => {
      if (change === "command") f.setCurrent({ ...f.sealed, command: "other" });
      if (change === "effective-env") f.deps.resolve = async () => ({ ...plain, env: { ...plain.env, NODE_OPTIONS: "--require /tmp/changed.js" } });
      if (change === "document") f.deps.isCurrent = () => false;
      return change !== "cancel";
    };
    const operation = approveReviewedMcpLaunch(plain.id, mcpStdioLaunchFingerprint(f.sealed), f.deps);
    if (change === "cancel" || change === "document") await assert.rejects(operation, /cancelled|no longer active/u);
    else assert.equal(await operation, false);
    assert.equal(await f.approvals.isApproved(f.sealed), false);
  }
});

test("effective launch review escapes control characters without truncating environment values", () => {
  const unusual = { ...plain, args: ["line\nbreak", "quote\"value", "visible\u202ehidden"], env: { PATH: "/bin", NODE_OPTIONS: "--require x\n--inspect", TOKEN: "a".repeat(16_384) } };
  const text = mcpLaunchReviewText(unusual);
  assert.deepEqual(JSON.parse(text), { command: unusual.command, args: unusual.args, env: unusual.env });
  assert.ok(text.includes("line\\nbreak"));
  assert.ok(text.includes("visible\\u202ehidden"));
  assert.equal(text.includes("\u202e"), false);
});

test("configured stdio plaintext never reaches a transport even if an old launch was approved", async () => {
  let resolutions = 0;
  await assert.rejects(resolveMcpConnectionCredentials(plain, {
    isLaunchApproved: async () => true, resolveFieldSecrets: async (server) => { resolutions++; return server; },
    presetKey: async () => null, isCurrent: () => true, missingKey: () => "missing",
  }), /secure storage/u);
  assert.equal(resolutions, 0);
});
