import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { mcpStdioLaunchFingerprint } from "./mcp-field-secrets-core.js";
import { createMcpStdioApprovalStore, publishWithLaunchApproval } from "./mcp-stdio-approvals.js";
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

test("an editor save keeps the configured launch approved until its new command is published", async (t) => {
  const { approvals } = await store(t);
  const old: McpServer = { ...local, command: "node", args: ["old.js"] };
  const edited: McpServer = { ...local, command: "node", args: ["new.js"] };
  let configured: McpServer | undefined = old;
  await approvals.approve(old);

  // Publication fails after the approval was written: config.json still runs old.js.
  await assert.rejects(
    publishWithLaunchApproval(approvals, edited, true, async () => {
      assert.equal(await approvals.isApproved(old), true, "the configured launch stays approved during the save");
      throw new Error("disk full");
    }, async () => configured),
    /disk full/u,
  );
  assert.equal(await approvals.isApproved(old), true);
  assert.equal(await approvals.isApproved(edited), false);

  // The save goes through: only the published command may run.
  const saved = await publishWithLaunchApproval(approvals, edited, true, async () => {
    configured = edited;
    return edited;
  }, async () => configured);
  assert.deepEqual(saved, edited);
  assert.equal(await approvals.isApproved(edited), true);
  assert.equal(await approvals.isApproved(old), false);
});

test("reconciling against config never approves a hand-edited command and forgets removed servers", async (t) => {
  const { approvals } = await store(t);
  const edited: McpServer = { ...local, args: ["server", "--evil"] };
  await approvals.approve(local);
  // A save that never reached publication left its launch approved alongside.
  await approvals.approveAlongside(edited);
  assert.equal(await approvals.isApproved(local), true);

  // The authoritative config still holds the original: the unpublished launch goes.
  await approvals.retainOnly(local.id, local);
  assert.equal(await approvals.isApproved(local), true);
  assert.equal(await approvals.isApproved(edited), false);

  // config.json was hand-edited to another command: nothing stays approved.
  await approvals.retainOnly(local.id, edited);
  assert.equal(await approvals.isApproved(edited), false);
  assert.equal(await approvals.isApproved(local), false);

  await approvals.approve(local);
  await approvals.retainOnly(local.id, undefined);
  assert.equal(await approvals.isApproved(local), false);
});
