import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TELEGRAM_PROFILE,
  listTelegramProfileNames,
  normalizeTelegramProfileName,
  projectTelegramProfile,
  telegramProfilePatch,
  telegramProfileRuntimeFile,
  telegramProfileTokenKey,
} from "./telegram-profile-config.js";

test("named Telegram profiles project isolated settings and storage identities", () => {
  const settings = {
    telegramEnabled: true,
    telegramModel: "default-model",
    telegramProfiles: {
      work: { enabled: false, model: "work-model", workspaceId: "workspace-1" },
    },
  };
  assert.equal(projectTelegramProfile(settings, DEFAULT_TELEGRAM_PROFILE).telegramModel, "default-model");
  const work = projectTelegramProfile(settings, "work");
  assert.equal(work.telegramEnabled, false);
  assert.equal(work.telegramModel, "work-model");
  assert.equal(work.telegramWorkspaceId, "workspace-1");
  assert.equal(telegramProfileTokenKey("work"), "telegram:work");
  assert.equal(telegramProfileRuntimeFile("work"), "telegram-runtime-work.json");
  assert.deepEqual(listTelegramProfileNames(settings), ["default", "work"]);
});

test("profile patches do not alter another profile", () => {
  const settings = { telegramProfiles: { work: { model: "old" }, home: { model: "home" } } };
  const patch = telegramProfilePatch(settings, "work", { telegramModel: "new" });
  assert.equal(patch.telegramProfiles?.work?.model, "new");
  assert.equal(patch.telegramProfiles?.home?.model, "home");
});

test("profile names are bounded and reserve routing aliases", () => {
  assert.equal(normalizeTelegramProfileName(" Work2 "), "work2");
  assert.throws(() => normalizeTelegramProfileName("main"));
  assert.throws(() => normalizeTelegramProfileName("bad-name"));
  assert.throws(() => normalizeTelegramProfileName("x".repeat(33)));
});
