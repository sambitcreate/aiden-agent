import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEGRAM_PROFILE_CHANGED_MESSAGE,
  TelegramProfileMutationFence,
} from "./telegram-profile-mutation-fence.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reset request invalidates an in-flight bind before its commit and runs afterward", async () => {
  const fence = new TelegramProfileMutationFence();
  const prepared = deferred();
  const resume = deferred();
  const events: string[] = [];

  const bind = fence.runBinding("work", async (admission) => {
    events.push("bind:prepare");
    prepared.resolve();
    await resume.promise;
    admission.assertCurrent();
    events.push("bind:commit");
  });
  await prepared.promise;
  const reset = fence.runDestructive("work", async () => {
    events.push("reset");
  });
  resume.resolve();

  await assert.rejects(bind, new RegExp(TELEGRAM_PROFILE_CHANGED_MESSAGE, "u"));
  await reset;
  assert.deepEqual(events, ["bind:prepare", "reset"]);
});

test("a bind queued behind profile deletion observes only post-delete state", async () => {
  const fence = new TelegramProfileMutationFence();
  const deleting = deferred();
  const resume = deferred();
  let profileExists = true;

  const deletion = fence.runDestructive("work", async () => {
    deleting.resolve();
    await resume.promise;
    profileExists = false;
  });
  await deleting.promise;
  const bind = fence.runBinding("work", async () => {
    assert.equal(profileExists, false);
    throw new Error(
      "Choose a Telegram profile that has a token and paired owner.",
    );
  });
  resume.resolve();

  await deletion;
  await assert.rejects(bind, /paired owner/u);
});

test("profile lanes are independent", async () => {
  const fence = new TelegramProfileMutationFence();
  const hold = deferred();
  const work = fence.runDestructive("work", () => hold.promise);
  let personalRan = false;
  await fence.runBinding("personal", async () => {
    personalRan = true;
  });
  assert.equal(personalRan, true);
  hold.resolve();
  await work;
});
