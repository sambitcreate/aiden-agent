import assert from "node:assert/strict";
import test from "node:test";
import { resolveBotInboundAttachmentHome } from "./bot-inbound-attachment-home.js";

const managed = {
  botId: "bot-1",
  workspaceId: "8604cafe-0648-4b86-bdaa-fc6f27cc4781",
  homePath: "/private/aiden/bots/home-8604cafe-0648-4b86-bdaa-fc6f27cc4781",
  createdAt: 1,
  incarnation: { device: "2", inode: "3" },
};

test("resolves the canonical managed home for Bot-bound inbound attachments", async () => {
  const calls: string[] = [];
  const lease = await resolveBotInboundAttachmentHome({
      botId: managed.botId,
      workspaceId: managed.workspaceId,
      resolveManagedWorkspace: async (botId) => {
        calls.push(`resolve:${botId}`);
        return managed;
      },
      canonicalize: async (candidate) => {
        calls.push(`canonical:${candidate}`);
        return candidate;
      },
      revalidateManagedWorkspace: async (expected) => {
        calls.push(`revalidate:${expected.workspaceId}`);
        return managed;
      },
    });
  assert.equal(lease?.homePath, managed.homePath);
  assert.deepEqual(lease?.identity, managed.incarnation);
  assert.deepEqual(calls, [
    "resolve:bot-1",
    `revalidate:${managed.workspaceId}`,
    `canonical:${managed.homePath}`,
  ]);
  await lease?.revalidateBeforeEffect();
  assert.deepEqual(calls.slice(-2), [
    `revalidate:${managed.workspaceId}`,
    `canonical:${managed.homePath}`,
  ]);
});

test("ordinary inbound attachments retain the existing non-Bot destination path", async () => {
  let touched = false;
  assert.equal(
    await resolveBotInboundAttachmentHome({
      workspaceId: "ordinary-workspace",
      resolveManagedWorkspace: async () => {
        touched = true;
        return managed;
      },
      canonicalize: async () => {
        touched = true;
        return managed.homePath;
      },
      revalidateManagedWorkspace: async () => {
        touched = true;
        return managed;
      },
    }),
    undefined,
  );
  assert.equal(touched, false);
});

test("Bot-bound input fails closed on missing or mismatched identity and workspace", async () => {
  const candidates = [
    { botId: managed.botId, workspaceId: undefined, resolved: managed },
    {
      botId: managed.botId,
      workspaceId: "wrong-workspace",
      resolved: managed,
    },
    {
      botId: managed.botId,
      workspaceId: managed.workspaceId,
      resolved: { ...managed, botId: "bot-2" },
    },
  ];
  for (const candidate of candidates) {
    await assert.rejects(
      resolveBotInboundAttachmentHome({
        botId: candidate.botId,
        workspaceId: candidate.workspaceId,
        resolveManagedWorkspace: async () => candidate.resolved,
        canonicalize: async (candidatePath) => candidatePath,
        revalidateManagedWorkspace: async (expected) => expected,
      }),
      /missing its managed home|does not match its managed home/u,
    );
  }
});

test("rejects path traversal, filesystem roots, and symlink redirection", async () => {
  for (const homePath of ["/private/aiden/home/../escape", "/", "relative/home"]) {
    await assert.rejects(
      resolveBotInboundAttachmentHome({
        botId: managed.botId,
        workspaceId: managed.workspaceId,
        resolveManagedWorkspace: async () => ({ ...managed, homePath }),
        canonicalize: async (candidate) => candidate,
        revalidateManagedWorkspace: async (expected) => expected,
      }),
      /unsafe managed home/u,
    );
  }
  await assert.rejects(
    resolveBotInboundAttachmentHome({
      botId: managed.botId,
      workspaceId: managed.workspaceId,
      resolveManagedWorkspace: async () => managed,
      canonicalize: async () => "/private/redirected-home",
      revalidateManagedWorkspace: async (expected) => expected,
    }),
    /managed home workspace changed/u,
  );
});

test("re-proves the exact managed-home incarnation around attachment effects", async () => {
  let valid = true;
  const lease = await resolveBotInboundAttachmentHome({
    botId: managed.botId,
    workspaceId: managed.workspaceId,
    resolveManagedWorkspace: async () => managed,
    canonicalize: async (candidate) => candidate,
    revalidateManagedWorkspace: async () =>
      valid ? managed : { ...managed, incarnation: { device: "2", inode: "999" } },
  });
  assert.ok(lease);
  valid = false;
  await assert.rejects(
    lease.revalidateBeforeEffect(),
    /managed home workspace changed/u,
  );
});
