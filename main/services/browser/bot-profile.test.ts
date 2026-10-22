import assert from "node:assert/strict";
import test from "node:test";
import {
  botBrowserPartition,
  botBrowserProfileId,
  botIdOfBrowserProfile,
  isBotBrowserProfileId,
} from "./bot-profile.js";
import { browserPartition } from "./core.js";
import {
  botIdForBrowserWorkspace,
  browserWorkspacesOfBot,
  forgetBotBrowserWorkspace,
  registerBotBrowserWorkspace,
} from "./bot-workspaces.js";

test("a Bot's browser profile round-trips its id and never looks like a person's profile", () => {
  const id = botBrowserProfileId("bot:2f1c");
  assert.equal(isBotBrowserProfileId(id), true);
  assert.equal(botIdOfBrowserProfile(id), "bot:2f1c");
  for (const personal of ["default", "private", "profile-0b6d0d2f-8e47-4d61-9f43-3d4f0b9a1e2c"]) {
    assert.equal(isBotBrowserProfileId(personal), false, personal);
    assert.equal(botIdOfBrowserProfile(personal), undefined, personal);
  }
  assert.equal(isBotBrowserProfileId("bot:"), false);
});

test("each Bot gets its own persistent partition, apart from every workspace profile", () => {
  const first = botBrowserPartition("bot:2f1c");
  const second = botBrowserPartition("bot:9a77");
  assert.notEqual(first, second);
  for (const partition of [first, second]) {
    assert.ok(partition.startsWith("persist:"), partition);
    // One safe path segment: Electron stores the partition in a directory of that name.
    assert.doesNotMatch(partition.slice("persist:".length), /[/\\:]/u);
  }
  for (const profile of ["default", "private", "profile-1"]) {
    assert.notEqual(first, browserPartition(profile, false));
    assert.notEqual(first, browserPartition(botBrowserProfileId("bot:2f1c"), false));
  }
});

test("a Bot id that can't name a directory has no browser profile", () => {
  assert.throws(() => botBrowserProfileId("bot:../x/y"));
  assert.throws(() => botBrowserPartition(""));
});

test("the admission registry maps a managed workspace to exactly one Bot until it is forgotten", () => {
  registerBotBrowserWorkspace("managed-a", "bot:a");
  registerBotBrowserWorkspace("managed-a", "bot:a");
  registerBotBrowserWorkspace("managed-a2", "bot:a");
  registerBotBrowserWorkspace("managed-b", "bot:b");
  assert.equal(botIdForBrowserWorkspace("managed-a"), "bot:a");
  assert.equal(botIdForBrowserWorkspace("workspace-of-the-person"), undefined);
  assert.throws(() => registerBotBrowserWorkspace("managed-a", "bot:b"), /another Bot/u);
  assert.deepEqual(browserWorkspacesOfBot("bot:a").sort(), ["managed-a", "managed-a2"]);
  forgetBotBrowserWorkspace("bot:a");
  assert.equal(botIdForBrowserWorkspace("managed-a"), undefined);
  assert.deepEqual(browserWorkspacesOfBot("bot:a"), []);
  assert.equal(botIdForBrowserWorkspace("managed-b"), "bot:b");
  forgetBotBrowserWorkspace("bot:b");
});
