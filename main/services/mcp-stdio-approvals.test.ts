import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { mcpStdioLaunchFingerprint } from "./mcp-field-secrets-core.js";
import { createMcpStdioApprovalStore } from "./mcp-stdio-approvals.js";
import type { McpServer } from "./types.js";

const local: McpServer = { id: "files", name: "Files", transport: "stdio", command: "npx", args: ["server"], enabled: true };

async function store(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-stdio-approvals-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "mcp-stdio-approvals.json");
  return { file, approvals: createMcpStdioApprovalStore(async () => file) };
}

test("a local server runs only with the exact launch that was approved", async (t) => {
  const { file, approvals } = await store(t);
  assert.equal(await approvals.isApproved(local), false);
  await approvals.approve(local);
  assert.equal(await approvals.isApproved(local), true);
  assert.equal(await approvals.isApproved({ ...local, name: "Renamed", enabled: false }), true);
  // A hand edit to the command, arguments or environment needs a new approval.
  assert.equal(await approvals.isApproved({ ...local, args: ["server", "--evil"] }), false);
  assert.equal(await approvals.isApproved({ ...local, env: { PATH: "/tmp" } }), false);
  // Remote servers never need it.
  assert.equal(await approvals.isApproved({ id: "r", name: "R", transport: "http", url: "https://r.test", enabled: true }), true);
  // Owner-only file in application support.
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("approving what Settings showed fails when the command changed in between", async (t) => {
  const { approvals } = await store(t);
  const shown = mcpStdioLaunchFingerprint(local);
  const edited = { ...local, command: "curl" };
  assert.equal(await approvals.approveShown(edited, shown), false);
  assert.equal(await approvals.isApproved(edited), false);
  assert.equal(await approvals.approveShown(local, shown), true);
  assert.equal(await approvals.isApproved(local), true);
});

test("removing a server forgets its approval, and an unreadable file approves nothing", async (t) => {
  const { file, approvals } = await store(t);
  await approvals.approve(local);
  await approvals.forget(local.id);
  assert.equal(await approvals.isApproved(local), false);
  await approvals.approve(local);
  await fs.writeFile(file, "{not json");
  assert.equal(await approvals.isApproved(local), false);
  // A hand-written approval for another fingerprint does not count.
  await fs.writeFile(file, JSON.stringify({ version: 1, approved: { files: "0".repeat(64) } }));
  assert.equal(await approvals.isApproved(local), false);
});
