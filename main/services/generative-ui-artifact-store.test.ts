import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  GenerativeUiArtifactStore,
  designArtifactRecoveryFingerprint,
  remappedHtmlArtifactMediaId,
} from "./generative-ui-artifact-store.js";
import type { ChatHtmlArtifactV1 } from "../../renderer/shared/chat-artifacts.js";
import {
  MAX_HTML_ARTIFACT_BYTES,
  MAX_HTML_ARTIFACT_BYTES_PER_CHAT,
} from "../../renderer/shared/generative-ui.js";
import { newArtboardOwnership } from "./design-generated-revision-contract.js";

const HTML = "<p>hello</p>";
const temporaryDirectories: string[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function storageRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-html-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function artifact(id: string, title = "Chart"): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id,
    title,
    mimeType: "text/html",
    size: Buffer.byteLength(HTML, "utf8"),
    mediaId: id,
  };
}

function artifactWithHtml(mediaId: string, html: string, title = "Chart"): ChatHtmlArtifactV1 {
  return {
    version: 1,
    kind: "html",
    id: createHash("sha256").update(html).digest("hex"),
    title,
    mimeType: "text/html",
    size: Buffer.byteLength(html, "utf8"),
    mediaId,
  };
}

function htmlWithExactBytes(bytes: number, marker: string): string {
  const prefix = `<!doctype html><html><body><main>${marker}</main><!--`;
  const suffix = "--></body></html>";
  return `${prefix}${"x".repeat(bytes - Buffer.byteLength(prefix + suffix, "utf8"))}${suffix}`;
}

test("chat copies preserve the Design artifact namespace", () => {
  assert.match(remappedHtmlArtifactMediaId("target", "design:source"), /^design:[a-f0-9]{64}$/u);
  assert.match(remappedHtmlArtifactMediaId("target", "source"), /^[a-f0-9]{64}$/u);
});

test("Design artifact copies remap revision parents and reject child-only copies", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const parent = artifact("design:parent");
  const child = { ...artifact("design:child"), revisionOfMediaId: parent.mediaId };
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-parent",
    artifact: parent,
    html: HTML,
  });
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-child",
    artifact: child,
    html: HTML,
  });
  await store.commit("source-chat", [parent.mediaId, child.mediaId]);

  const copies = await store.prepareSelectedCopy("source-chat", "target-chat", [
    parent.mediaId,
    child.mediaId,
  ]);
  const copiedParent = copies.find((item) => item.revisionOfMediaId === undefined)!;
  const copiedChild = copies.find((item) => item.revisionOfMediaId !== undefined)!;
  assert.equal(copiedChild.revisionOfMediaId, copiedParent.mediaId);
  assert.notEqual(copiedChild.revisionOfMediaId, parent.mediaId);

  await assert.rejects(
    store.prepareSelectedCopy("source-chat", "other-chat", [child.mediaId]),
    /missing its revision parent/u,
  );
});

test("Design ownership is exact, legacy rows stay readable, and copies drop source ownership", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const owned = artifact("design:owned");
  await assert.rejects(
    store.stage({
      chatId: "source-chat",
      generationId: "generation-owned",
      artifact: owned,
      html: HTML,
      designOwnership: {
        ...newArtboardOwnership("project-one", owned.mediaId),
        lineageId: "lineage:forged",
      },
    }),
    /invalid generative-ui artifact staging/iu,
  );
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-owned",
    artifact: owned,
    html: HTML,
    designOwnership: newArtboardOwnership("project-one", owned.mediaId),
  });
  const legacy = artifact("design:legacy");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-legacy",
    artifact: legacy,
    html: HTML,
  });
  await store.commit("source-chat", [owned.mediaId, legacy.mediaId]);

  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  assert.ok(await restarted.committedSourceFor("source-chat", legacy.mediaId));
  assert.deepEqual(await restarted.committedRecoverySourceFor("source-chat", owned.mediaId), {
    chatId: "source-chat",
    generationId: "generation-owned",
    artifact: owned,
    html: HTML,
    createdAt: 42,
    designOwnership: newArtboardOwnership("project-one", owned.mediaId),
    designPublication: "candidate",
  });
  const [copy] = await restarted.prepareSelectedCopy("source-chat", "target-chat", [owned.mediaId]);
  assert.ok(copy);
  assert.deepEqual(
    await restarted.designPublicationRecords(["candidate", "eligible", "published", "suppressed"], {
      chatId: "target-chat",
    }),
    [],
  );
});

test("live Design candidate reads require the exact pending generation and close at commitment", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("design:live-candidate");
  await store.stage({
    chatId: "chat:live",
    generationId: "generation:live",
    artifact: item,
    html: HTML,
    designOwnership: newArtboardOwnership("project:live", item.mediaId),
  });

  assert.equal(
    (
      await store.liveDesignCandidateSourceFor({
        chatId: "chat:live",
        generationId: "generation:live",
        mediaId: item.mediaId,
      })
    )?.html,
    HTML,
  );
  assert.equal(
    await store.liveDesignCandidateSourceFor({
      chatId: "chat:live",
      generationId: "generation:other",
      mediaId: item.mediaId,
    }),
    undefined,
  );
  assert.equal(
    await store.liveDesignCandidateSourceFor({
      chatId: "chat:other",
      generationId: "generation:live",
      mediaId: item.mediaId,
    }),
    undefined,
  );

  await store.commit("chat:live", [item.mediaId]);
  assert.equal(
    await store.liveDesignCandidateSourceFor({
      chatId: "chat:live",
      generationId: "generation:live",
      mediaId: item.mediaId,
    }),
    undefined,
  );
});

test("staging, commit, recovery, and pending gates", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  assert.equal(
    await store.stage({
      chatId: "chat-1",
      generationId: "gen-1",
      model: "test-model",
      artifact: item,
      html: HTML,
    }),
    "inserted",
  );
  assert.equal(await store.hasPending("chat-1"), true);
  const recovered: Array<{ chatId: string; htmlArtifacts: ChatHtmlArtifactV1[] }> = [];
  await store.recover([{ id: "chat-1", messages: [] }], async (message) => {
    recovered.push(message);
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.htmlArtifacts[0]?.mediaId, "media-1");
  assert.equal(await store.hasPending("chat-1"), false);
  assert.equal(await store.htmlFor("chat-1", "media-1"), HTML);
});

test("an exact failed coordinator can discard only its own pending artifact", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "chat-1",
    generationId: "direct-edit-1",
    artifact: item,
    html: HTML,
  });

  await assert.rejects(
    store.discardPending({
      chatId: "chat-1",
      generationId: "another-operation",
      mediaId: item.mediaId,
    }),
    /not owned/iu,
  );
  assert.equal(await store.hasPending("chat-1"), true);
  assert.equal(
    await store.discardPending({
      chatId: "chat-1",
      generationId: "direct-edit-1",
      mediaId: item.mediaId,
    }),
    "discarded",
  );
  assert.equal(await store.hasPending("chat-1"), false);
  assert.equal(
    await store.discardPending({
      chatId: "chat-1",
      generationId: "direct-edit-1",
      mediaId: item.mediaId,
    }),
    "missing",
  );

  await store.stage({
    chatId: "chat-1",
    generationId: "direct-edit-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("chat-1", [item.mediaId]);
  await assert.rejects(
    store.discardPending({
      chatId: "chat-1",
      generationId: "direct-edit-1",
      mediaId: item.mediaId,
    }),
    /not owned/iu,
  );
  assert.equal(await store.htmlFor("chat-1", item.mediaId), HTML);
});

test("a missing-artifact guard excludes later writers and preserves pending rows", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const guardedMediaId = "design:guarded";
  const guardStarted = deferred<void>();
  const releaseProjectCas = deferred<void>();
  const guarded = store.withMissingArtifactGuard("chat-guard", guardedMediaId, async () => {
    guardStarted.resolve();
    await releaseProjectCas.promise;
    return "project-cas-complete";
  });
  await guardStarted.promise;
  let stageSettled = false;
  let commitSettled = false;
  const staged = artifact(guardedMediaId, "Guarded");
  const stageWrite = store
    .stage({
      chatId: "chat-guard",
      generationId: "generation-guarded",
      artifact: staged,
      html: HTML,
    })
    .then(() => void (stageSettled = true));
  const commitWrite = store
    .commit("chat-guard", [guardedMediaId])
    .then(() => void (commitSettled = true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stageSettled, false, "artifact staging waits behind the project CAS guard");
  assert.equal(commitSettled, false, "artifact commit waits behind the project CAS guard");
  releaseProjectCas.resolve();
  assert.deepEqual(await guarded, { status: "completed", value: "project-cas-complete" });
  await Promise.all([stageWrite, commitWrite]);
  assert.equal(stageSettled, true);
  assert.equal(commitSettled, true);
  assert.ok(await store.committedSourceFor("chat-guard", guardedMediaId));

  const pendingMediaId = "design:pending-guard";
  await store.stage({
    chatId: "chat-guard",
    generationId: "generation-pending",
    artifact: artifact(pendingMediaId, "Pending"),
    html: HTML,
  });
  let projectCasCalled = false;
  assert.deepEqual(
    await store.withMissingArtifactGuard("chat-guard", pendingMediaId, async () => {
      projectCasCalled = true;
    }),
    { status: "artifact-present" },
  );
  assert.equal(projectCasCalled, false, "an in-flight artifact preserves its project membership");
});

test("a damaged-artifact guard admits only the exact committed invalid fingerprint", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const damaged = { ...artifactWithHtml("design:damaged-guard", HTML), id: "0".repeat(64) };
  const validHtml = "<p>valid guard</p>";
  const valid = artifactWithHtml("design:valid-guard", validHtml);
  await store.stage({
    chatId: "chat:damaged-guard",
    generationId: "damaged-generation",
    artifact: damaged,
    html: HTML,
  });
  await store.stage({
    chatId: "chat:damaged-guard",
    generationId: "valid-generation",
    artifact: valid,
    html: validHtml,
    designOwnership: newArtboardOwnership("project:damaged-guard", valid.mediaId),
  });
  await store.commit("chat:damaged-guard", [damaged.mediaId, valid.mediaId]);
  const damagedSource = await store.committedRecoverySourceFor(
    "chat:damaged-guard",
    damaged.mediaId,
  );
  const validSource = await store.committedRecoverySourceFor(
    "chat:damaged-guard",
    valid.mediaId,
  );
  assert.ok(damagedSource);
  assert.ok(validSource);
  let mutations = 0;
  assert.deepEqual(
    await store.withDamagedArtifactGuard(
      {
        chatId: "chat:damaged-guard",
        mediaId: damaged.mediaId,
        expectedFingerprint: designArtifactRecoveryFingerprint(damagedSource),
      },
      async () => ++mutations,
    ),
    { status: "completed", value: 1 },
  );
  assert.deepEqual(
    await store.withDamagedArtifactGuard(
      {
        chatId: "chat:damaged-guard",
        mediaId: valid.mediaId,
        expectedFingerprint: designArtifactRecoveryFingerprint(validSource),
      },
      async () => ++mutations,
    ),
    { status: "artifact-valid" },
  );
  await store.setDesignPublicationState(
    "chat:damaged-guard",
    [valid.mediaId],
    ["candidate"],
    "eligible",
  );
  assert.deepEqual(
    await store.withDamagedArtifactGuard(
      {
        chatId: "chat:damaged-guard",
        mediaId: valid.mediaId,
        expectedFingerprint: designArtifactRecoveryFingerprint(validSource),
        allowValidContent: true,
      },
      async () => ++mutations,
    ),
    { status: "artifact-changed" },
    "publication changes invalidate the inspected recovery fingerprint",
  );
  const eligibleSource = await store.committedRecoverySourceFor(
    "chat:damaged-guard",
    valid.mediaId,
  );
  assert.ok(eligibleSource);
  assert.deepEqual(
    await store.withDamagedArtifactGuard(
      {
        chatId: "chat:damaged-guard",
        mediaId: valid.mediaId,
        expectedFingerprint: designArtifactRecoveryFingerprint(eligibleSource),
        allowValidContent: true,
      },
      async () => ++mutations,
    ),
    { status: "completed", value: 2 },
  );
  assert.deepEqual(
    await store.withDamagedArtifactGuard(
      {
        chatId: "chat:damaged-guard",
        mediaId: damaged.mediaId,
        expectedFingerprint: "f".repeat(64),
      },
      async () => ++mutations,
    ),
    { status: "artifact-changed" },
  );
  assert.equal(mutations, 2);
});

test("chat HTML quotas refuse extra staged artifacts", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root });
  await store.initialize();
  for (let index = 0; index < 40; index += 1) {
    const id = `media-${index}`;
    await store.stage({
      chatId: "chat-1",
      generationId: `gen-${index}`,
      artifact: artifact(id, `Title ${index}`),
      html: HTML,
    });
  }
  await assert.rejects(
    store.stage({
      chatId: "chat-1",
      generationId: "overflow",
      artifact: artifact("overflow", "Overflow"),
      html: HTML,
    }),
    /artifact limit/iu,
  );
});

test("Design recovery atomically prunes only its proven damaged row at the record limit", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const chatId = "chat:record-limit";
  const damagedMediaId = "design:damaged-record-limit";
  const damaged = {
    ...artifactWithHtml(damagedMediaId, HTML, "Damaged"),
    id: "0".repeat(64),
  };
  await store.stage({ chatId, generationId: "damaged", artifact: damaged, html: HTML });
  for (let index = 1; index < 40; index += 1) {
    const html = `<p>filler ${index}</p>`;
    await store.stage({
      chatId,
      generationId: `filler-${index}`,
      artifact: artifactWithHtml(`design:filler-${index}`, html),
      html,
    });
  }
  await store.commit(
    chatId,
    [damagedMediaId, ...Array.from({ length: 39 }, (_, index) => `design:filler-${index + 1}`)],
  );
  const recoveredHtml = "<p>recovered</p>";
  const recovered = {
    ...artifactWithHtml("design:recovered-record-limit", recoveredHtml, "Recovered"),
    revisionOfMediaId: damagedMediaId,
  };
  assert.equal(
    await store.stageRecoveryReplacement({
      chatId,
      generationId: "journal-recovery:record-limit",
      artifact: recovered,
      html: recoveredHtml,
      designOwnership: {
        version: 1,
        kind: "revision",
        projectId: "project:record-limit",
        lineageId: "lineage:record-limit",
        baseMediaId: damagedMediaId,
      },
      damagedMediaId,
    }),
    "replaced",
  );
  assert.equal(await store.htmlFor(chatId, damagedMediaId), undefined);
  assert.equal(await store.htmlFor(chatId, recovered.mediaId), recoveredHtml);
  await assert.rejects(
    store.stageRecoveryReplacement({
      chatId,
      generationId: "journal-recovery:invalid-source",
      artifact: {
        ...artifactWithHtml("design:invalid-source-recovery", recoveredHtml),
        revisionOfMediaId: "design:filler-1",
      },
      html: recoveredHtml,
      designOwnership: {
        version: 1,
        kind: "revision",
        projectId: "project:record-limit",
        lineageId: "lineage:record-limit",
        baseMediaId: "design:filler-1",
      },
      damagedMediaId: "design:filler-1",
    }),
    /not an exact damaged artifact/iu,
  );
});

test("Design recovery can swap equal-sized valid journal bytes at the exact chat byte limit", async () => {
  const root = await storageRoot();
  const chatId = "chat:byte-limit";
  const damagedMediaId = "design:damaged-byte-limit";
  const records = Array.from({
    length: MAX_HTML_ARTIFACT_BYTES_PER_CHAT / MAX_HTML_ARTIFACT_BYTES,
  }, (_, index) => {
    const html = htmlWithExactBytes(MAX_HTML_ARTIFACT_BYTES, `record-${index}`);
    const storedArtifact = artifactWithHtml(
      index === 0 ? damagedMediaId : `byte-filler-${index}`,
      html,
    );
    if (index === 0) storedArtifact.id = "0".repeat(64);
    return {
      version: 1,
      chatId,
      generationId: `byte-generation-${index}`,
      artifact: storedArtifact,
      html,
      committed: true,
      stagedAt: index,
    };
  });
  await fs.writeFile(
    path.join(root, "generative-ui-artifacts.json"),
    JSON.stringify({ version: 1, revision: 1, records }),
    "utf8",
  );
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const recoveredHtml = htmlWithExactBytes(MAX_HTML_ARTIFACT_BYTES, "recovered");
  const recovered = {
    ...artifactWithHtml("design:recovered-byte-limit", recoveredHtml),
    revisionOfMediaId: damagedMediaId,
  };

  assert.equal(
    await store.stageRecoveryReplacement({
      chatId,
      generationId: "journal-recovery:byte-limit",
      artifact: recovered,
      html: recoveredHtml,
      designOwnership: {
        version: 1,
        kind: "revision",
        projectId: "project:byte-limit",
        lineageId: "lineage:byte-limit",
        baseMediaId: damagedMediaId,
      },
      damagedMediaId,
    }),
    "replaced",
  );
  assert.equal(await store.htmlFor(chatId, damagedMediaId), undefined);
  assert.equal(await store.htmlFor(chatId, recovered.mediaId), recoveredHtml);
  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  assert.deepEqual(restarted.availability(), { available: true });
  assert.equal(await restarted.htmlFor(chatId, recovered.mediaId), recoveredHtml);
});

test("recovery isolates a failing chat without blocking others", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  await store.stage({
    chatId: "chat-fail",
    generationId: "gen-1",
    artifact: artifact("fail-1"),
    html: HTML,
  });
  await store.stage({
    chatId: "chat-ok",
    generationId: "gen-1",
    artifact: artifact("ok-1"),
    html: HTML,
  });
  const recovered: string[] = [];
  await assert.rejects(
    store.recover(
      [
        { id: "chat-fail", messages: [] },
        { id: "chat-ok", messages: [] },
      ],
      async (message) => {
        if (message.chatId === "chat-fail") throw new Error("append failed");
        recovered.push(message.chatId);
      },
    ),
    /append failed/u,
  );
  assert.deepEqual(recovered, ["chat-ok"]);
  assert.equal(await store.hasPending("chat-ok"), false);
  assert.equal(await store.hasPending("chat-fail"), true);
});

test("reconcilePersisted commits staged rows already on the chat", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "chat-1",
    generationId: "gen-1",
    artifact: item,
    html: HTML,
  });
  await store.reconcilePersisted({
    id: "chat-1",
    messages: [{ role: "assistant", htmlArtifacts: [item] }],
  });
  assert.equal(await store.hasPending("chat-1"), false);
});

test("prepared chat copies recover to committed artifacts after chat installation", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);

  const [copy] = await store.prepareSelectedCopy("source-chat", "target-chat", [item.mediaId]);
  assert.ok(copy);
  assert.equal(await store.hasPending("target-chat"), true);

  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  await restarted.recover(
    [{ id: "target-chat", messages: [{ role: "assistant", htmlArtifacts: [copy] }] }],
    async () =>
      assert.fail("A prepared copy already referenced by chat must not append a message."),
  );

  assert.equal(await restarted.hasPending("target-chat"), false);
  assert.equal(await restarted.htmlFor("target-chat", copy.mediaId), HTML);
});

test("prepared chat copies are discarded when chat installation never happened", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root, now: () => 42 });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);
  const [copy] = await store.prepareSelectedCopy("source-chat", "target-chat", [item.mediaId]);
  assert.ok(copy);

  const restarted = new GenerativeUiArtifactStore({ root: () => root });
  await restarted.initialize();
  await restarted.recover([], async () => assert.fail("An orphaned copy must not be recovered."));

  assert.equal(await restarted.hasPending("target-chat"), false);
  assert.equal(await restarted.htmlFor("target-chat", copy.mediaId), undefined);
  assert.equal(await restarted.htmlFor("source-chat", item.mediaId), HTML);
});

test("preparing a copy fails atomically when any source artifact is missing", async () => {
  const root = await storageRoot();
  const store = new GenerativeUiArtifactStore({ root: () => root });
  await store.initialize();
  const item = artifact("media-1");
  await store.stage({
    chatId: "source-chat",
    generationId: "generation-1",
    artifact: item,
    html: HTML,
  });
  await store.commit("source-chat", [item.mediaId]);

  await assert.rejects(
    store.prepareSelectedCopy("source-chat", "target-chat", [item.mediaId, "missing"]),
    /could not be copied/iu,
  );
  assert.equal(await store.hasPending("target-chat"), false);
});

test("unreadable durable HTML storage remains in place and blocks mutations", async () => {
  const root = await storageRoot();
  const file = path.join(root, "generative-ui-artifacts.json");
  await fs.writeFile(file, "{", "utf8");
  const store = new GenerativeUiArtifactStore({ root: () => root });

  await store.initialize();

  assert.deepEqual(store.availability(), {
    available: false,
    reason: "Generative UI artifact staging is unreadable.",
  });
  assert.equal(await fs.readFile(file, "utf8"), "{");
  assert.equal(await store.hasPending("chat-1"), true);
  await assert.rejects(
    store.stage({
      chatId: "chat-1",
      generationId: "generation-1",
      artifact: artifact("media-1"),
      html: HTML,
    }),
    /unreadable/iu,
  );
  assert.equal(await fs.readFile(file, "utf8"), "{");
});

test("unsupported durable HTML storage is never replaced with an empty database", async () => {
  const root = await storageRoot();
  const file = path.join(root, "generative-ui-artifacts.json");
  const unsupported = JSON.stringify({ version: 99, revision: 0, records: [] });
  await fs.writeFile(file, unsupported, "utf8");
  const store = new GenerativeUiArtifactStore({ root: () => root });

  await store.initialize();

  assert.deepEqual(store.availability(), {
    available: false,
    reason: "Generative UI artifact staging has an unsupported shape.",
  });
  assert.equal(await fs.readFile(file, "utf8"), unsupported);
  await assert.rejects(store.htmlFor("chat-1", "media-1"), /unsupported shape/iu);
});
