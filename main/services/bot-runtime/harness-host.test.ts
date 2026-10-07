import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  BOT_SESSION_FILE,
  createBotHarnessHost,
  isBotHarnessHostUnavailable,
  type BotHarnessHost,
  type BotHarnessHostOptions,
} from "./harness-host.js";
import { spawnHarnessChild } from "./test-support/child.js";
import { createFauxModels, FAUX_MODEL_REF, slowAnswer, waitFor, type FauxModels } from "./test-support/faux.js";

const ctx = BACKGROUND_CONTEXT;
const roots: string[] = [];
function tempProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-host-"));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function hostFor(
  profileDir: string,
  fauxModels: FauxModels,
  extra: Partial<BotHarnessHostOptions> = {},
): Promise<BotHarnessHost> {
  const host = await createBotHarnessHost({
    profileDir,
    buildRegistry: () => createRegistry(),
    models: fauxModels.models,
    ...extra,
  });
  assert.ok(!isBotHarnessHostUnavailable(host), "profile lock should be free");
  return host;
}

test("(a) the root conversation survives close and reopen", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("hi there")]);
  const host = await hostFor(profile, fauxModels);
  try {
    const first = await host.open("bot-a");
    await first.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    const submission = await first.conversation.submit({ type: "input", content: "hello" }, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");
    await host.close("bot-a");
    assert.equal(host.isOpen("bot-a"), false);

    const second = await host.open("bot-a");
    assert.equal(second.conversation.id, first.conversation.id);
    const view = await second.conversation.context(ctx);
    const answers = view.entries.filter((entry) => entry.kind === AssistantEntry.kind);
    assert.equal(answers.length, 1, "the earlier answer is still in the reopened conversation");
  } finally {
    await host.shutdown();
  }
});

test("(a2) an idle harness closes by itself and reopens mid-conversation", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  const host = await hostFor(profile, fauxModels, { idleCloseMs: 50 });
  try {
    const { conversation } = await host.open("bot-idle");
    await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    await (await conversation.submit({ type: "input", content: "first" }, ctx)).wait(ctx);
    await waitFor(() => !host.isOpen("bot-idle"), { what: "idle close" });

    const reopened = await host.open("bot-idle");
    await (await reopened.conversation.submit({ type: "input", content: "second" }, ctx)).wait(ctx);
    const view = await reopened.conversation.context(ctx);
    assert.deepEqual(
      view.entries.filter((entry) => entry.kind === "pi.user").length,
      2,
      "both turns are in one conversation",
    );
    assert.equal(fauxModels.calls(), 2);
  } finally {
    await host.shutdown();
  }
});

test("(b) after SIGKILL mid-stream the scan reports the Bot without calling the provider", async () => {
  const profile = tempProfile();
  const child = spawnHarnessChild("stream", [profile, "bot:killed", "req-1"]);
  const submissionId = await child.waitFor("STREAMING");
  await child.kill();

  const fauxModels = createFauxModels([fauxAssistantMessage("should never be requested")]);
  const host = await hostFor(profile, fauxModels);
  try {
    const interrupted = await host.interruptedBots();
    assert.deepEqual(interrupted, [{ botId: "bot:killed", submissionId }]);
    // Give a wrongly started scheduler time to reach the provider.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fauxModels.calls(), 0, "the scan must not resume the interrupted turn");
    const inspection = await host.inspect("bot:killed");
    assert.equal(inspection.scheduling, "paused");
  } finally {
    await host.shutdown();
  }
});

test("(b2) the scan closes Bots that have nothing to recover", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([fauxAssistantMessage("done")]);
  const first = await hostFor(profile, fauxModels);
  const { conversation } = await first.open("bot-calm");
  await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
  await (await conversation.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  await first.shutdown();

  const host = await hostFor(profile, createFauxModels());
  try {
    assert.deepEqual(await host.interruptedBots(), []);
    assert.equal(host.isOpen("bot-calm"), false);
  } finally {
    await host.shutdown();
  }
});

test("(c) destroy during a live stream aborts it and removes the Bot directory", async () => {
  const profile = tempProfile();
  const fauxModels = createFauxModels([slowAnswer(), fauxAssistantMessage("never")], { tokensPerSecond: 40 });
  const host = await hostFor(profile, fauxModels);
  try {
    const { conversation } = await host.open("bot-doomed");
    await conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    const submission = await conversation.submit({ type: "input", content: "go" }, ctx);
    await waitFor(async () => (await submission.status(ctx)).status === "placed" && fauxModels.calls() === 1, {
      what: "stream start",
    });

    await host.destroy("bot-doomed");
    assert.equal(existsSync(path.join(profile, "bots", "bot-doomed")), false);
    assert.equal(host.isOpen("bot-doomed"), false);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fauxModels.calls(), 1, "no further provider requests after delete");
    assert.equal(existsSync(path.join(profile, "bots", "bot-doomed")), false, "nothing reopened the files");
    await assert.rejects(host.open("bot-doomed"), /deleted/u);
  } finally {
    await host.shutdown();
  }
});

test("(d) sweepOrphans removes directories with no known Bot", async () => {
  const profile = tempProfile();
  const host = await hostFor(profile, createFauxModels());
  try {
    await host.open("bot:known");
    mkdirSync(path.join(profile, "bots", "bot-orphan"), { recursive: true });
    writeFileSync(path.join(profile, "bots", "bot-orphan", BOT_SESSION_FILE), "");
    const removed = await host.sweepOrphans(new Set(["bot:known"]));
    assert.deepEqual(removed, ["bot-orphan"]);
    assert.deepEqual(readdirSync(path.join(profile, "bots")).sort(), ["bot~3aknown", "runtime.lock"]);
  } finally {
    await host.shutdown();
  }
});

test("(e) a second host in another process is refused and touches nothing", async () => {
  const profile = tempProfile();
  const host = await hostFor(profile, createFauxModels());
  const child = spawnHarnessChild("host", [profile]);
  try {
    await host.open("bot-held");
    const before = readdirSync(path.join(profile, "bots")).sort();
    assert.deepEqual(JSON.parse(await child.waitFor("HOST")), { unavailable: "held_by_live_process" });
    assert.deepEqual(readdirSync(path.join(profile, "bots")).sort(), before);
  } finally {
    await child.kill();
    await host.shutdown();
  }
});

test("(e2) the profile is available again after shutdown", async () => {
  const profile = tempProfile();
  const host = await hostFor(profile, createFauxModels());
  await host.shutdown();
  const child = spawnHarnessChild("host", [profile]);
  try {
    assert.deepEqual(JSON.parse(await child.waitFor("HOST")), { ok: true });
  } finally {
    await child.kill();
  }
});

test("(f) a corrupt session file is moved aside and a fresh conversation opens", async () => {
  const profile = tempProfile();
  const dir = path.join(profile, "bots", "bot-corrupt");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, BOT_SESSION_FILE), "not a database at all ".repeat(100));
  const fauxModels = createFauxModels([fauxAssistantMessage("fresh")]);
  const host = await hostFor(profile, fauxModels, { now: () => 1_700_000_000_000 });
  try {
    const opened = await host.open("bot-corrupt");
    assert.equal(opened.recoveredCorruptFile, `${BOT_SESSION_FILE}.corrupt-1700000000000`);
    assert.ok(existsSync(path.join(dir, `${BOT_SESSION_FILE}.corrupt-1700000000000`)));
    await opened.conversation.configure({ model: FAUX_MODEL_REF }, ctx);
    const settled = await (await opened.conversation.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");

    // The notice is one-time.
    const again = await host.open("bot-corrupt");
    assert.equal(again.recoveredCorruptFile, undefined);
  } finally {
    await host.shutdown();
  }
});

test("open rejects ids that are not a single safe path segment", async () => {
  const host = await hostFor(tempProfile(), createFauxModels());
  try {
    await assert.rejects(host.open("../escape"), /Invalid Bot id/u);
    await assert.rejects(host.open(""), /Invalid Bot id/u);
  } finally {
    await host.shutdown();
  }
});
