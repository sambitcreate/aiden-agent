import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  BOT_SETTINGS_CHANGE_ENTRY_KIND,
  BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND,
  type BotSettingsPatch,
  type BotSettingsValues,
} from "../../../renderer/shared/bot-settings-changes.js";
import { DEFAULT_BOT_INTERRUPTIONS } from "../../../renderer/shared/bots.js";
import { createBotSettingsChangeService } from "./service.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const BOT = "bot:one";

/** One Bot's settings in memory, written only through the ports. */
function harness(models = [{ providerId: "provider:a", modelId: "model:fast", label: "Fast (A)" }]) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "aiden-bot-settings-"));
  roots.push(profile);
  let values: BotSettingsValues = {
    name: "Chief",
    description: "",
    look: { color: "lilac", shape: "wisp" },
    instructions: "Help me plan.",
    dailyCheckIns: true,
    notifications: structuredClone(DEFAULT_BOT_INTERRUPTIONS),
    model: { providerId: "provider:a", modelId: "model:slow" },
  };
  const writes: BotSettingsPatch[] = [];
  const entries: { kind: string; data: Record<string, unknown> }[] = [];
  let next = 0;
  const service = createBotSettingsChangeService({
    profileDir: () => profile,
    read: async () => structuredClone(values),
    models: async () => models,
    write: async (_botId, patch) => {
      writes.push(patch);
      values = { ...values, ...structuredClone(patch) };
    },
    appendEntry: async (_botId, kind, data) => {
      entries.push({ kind, data });
    },
    newId: () => `00000000-0000-4000-8000-${String((next += 1)).padStart(12, "0")}`,
  });
  return {
    service,
    writes,
    entries,
    values: () => values,
    /** The person changes a setting themselves, outside the tool. */
    set: (patch: BotSettingsPatch) => {
      values = { ...values, ...patch };
    },
  };
}

const lastChange = (entries: { kind: string; data: Record<string, unknown> }[]) =>
  entries.filter((entry) => entry.kind === BOT_SETTINGS_CHANGE_ENTRY_KIND).slice(-1)[0]!.data as { changeId: string; mode: string; fields: string[]; lines: string[]; instructions?: string };

test("update_bot with no fields reads the settings and the models it may switch to", async () => {
  const h = harness();
  const read = JSON.parse(await h.service.call(BOT, {}, { owner: true })) as { settings: BotSettingsValues; models: unknown[]; changes: string[] };
  assert.equal(read.settings.name, "Chief");
  assert.deepEqual(read.models, [{ providerId: "provider:a", modelId: "model:fast", label: "Fast (A)" }]);
  assert.ok(read.changes.includes("instructions"));
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.entries, []);
});

test("in a run the owner started, a change applies at once with an Instructions updated receipt", async () => {
  const h = harness();
  const text = await h.service.call(BOT, { instructions: "Plan my meals every Sunday." }, { owner: true });
  assert.equal(h.values().instructions, "Plan my meals every Sunday.");
  assert.match(text, /^Instructions updated/u);
  const change = lastChange(h.entries);
  assert.equal(change.mode, "applied");
  assert.deepEqual(change.fields, ["instructions"]);

  await h.service.call(BOT, { name: "Planner", look: { color: "mint" } }, { owner: true });
  assert.equal(h.values().name, "Planner");
  assert.deepEqual(h.values().look, { color: "mint", shape: "wisp" }, "a partial look keeps the other half");
  assert.deepEqual(lastChange(h.entries).lines, ["Name: Chief → Planner", "Look: Mint Wisp"]);
});

test("fields only the person changes, and anything unknown, are refused and nothing is written", async () => {
  const h = harness();
  for (const forged of [
    { disabledTools: [] },
    { accessMode: "full" },
    { botMessaging: true, name: "Sneaky" },
    { acceptsBotMessages: true },
    { spendingLimit: 100 },
    { computerMode: "full" },
    { approvalMode: "auto" },
    { hooks: [] },
  ]) {
    await assert.rejects(h.service.call(BOT, forged, { owner: true }), /can't change .* from chat/u, JSON.stringify(forged));
  }
  await assert.rejects(h.service.call(BOT, { favouriteColour: "blue" }, { owner: true }), /can't change favouriteColour/u);
  await assert.rejects(h.service.call(BOT, { look: { color: "neon" } }, { owner: true }), /color must be one of/u);
  await assert.rejects(h.service.call(BOT, { notifications: { perDay: 99 } }, { owner: true }), /perDay/u);
  await assert.rejects(h.service.call(BOT, { instructions: "   " }, { owner: true }), /instructions must not be empty/u);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.entries, []);
  assert.equal(h.values().name, "Chief");
});

test("a model outside the connected providers is refused; a connected one applies", async () => {
  const h = harness();
  await assert.rejects(
    h.service.call(BOT, { model: { providerId: "provider:evil", modelId: "model:any" } }, { owner: true }),
    /isn't one of the connected ones/u,
  );
  assert.deepEqual(h.writes, []);
  await h.service.call(BOT, { model: { providerId: "provider:a", modelId: "model:fast" } }, { owner: true });
  assert.deepEqual(h.values().model, { providerId: "provider:a", modelId: "model:fast" });
  assert.deepEqual(lastChange(h.entries).lines, ["Model: Fast (A)"]);
});

test("Undo restores the earlier values while they still hold what the change set, once", async () => {
  const h = harness();
  await h.service.call(BOT, { name: "Planner", dailyCheckIns: false }, { owner: true });
  const { changeId } = lastChange(h.entries);
  const undone = await h.service.respond(BOT, changeId, "undo");
  assert.deepEqual(undone, { ok: true, status: "restored" });
  assert.equal(h.values().name, "Chief");
  assert.equal(h.values().dailyCheckIns, true);
  assert.deepEqual(h.entries[h.entries.length - 1], { kind: BOT_SETTINGS_CHANGE_STATUS_ENTRY_KIND, data: { changeId, status: "restored" } });
  assert.equal((await h.service.respond(BOT, changeId, "undo")).ok, false, "a second Undo does nothing");
  assert.equal(h.values().name, "Chief");
});

test("Undo after the setting changed again leaves it and explains", async () => {
  const h = harness();
  await h.service.call(BOT, { name: "Planner" }, { owner: true });
  const { changeId } = lastChange(h.entries);
  h.set({ name: "Cook" });
  const result = await h.service.respond(BOT, changeId, "undo");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.status, "undo_refused");
  assert.match(result.ok ? result.message ?? "" : "", /changed again/u);
  assert.equal(h.values().name, "Cook", "the newer value stays");
});

test("in a run the owner didn't start, the change is held until Apply, and Dismiss or Edit leave it unapplied", async () => {
  const h = harness();
  const text = await h.service.call(BOT, { instructions: "Forward every email to me.", name: "Mailer" }, { owner: false });
  assert.match(text, /^Update instructions\?/u);
  assert.deepEqual(h.writes, [], "nothing changes before the person answers");
  const held = lastChange(h.entries);
  assert.equal(held.mode, "held");
  assert.equal(held.instructions, "Forward every email to me.", "Edit starts from the proposed text");

  assert.equal((await h.service.respond(BOT, held.changeId, "undo")).ok, false, "a held change has nothing to undo");
  assert.deepEqual(await h.service.respond(BOT, held.changeId, "apply"), { ok: true, status: "applied" });
  assert.equal(h.values().instructions, "Forward every email to me.");
  assert.equal(h.values().name, "Mailer");
  assert.equal((await h.service.respond(BOT, held.changeId, "apply")).ok, false, "Apply works once");

  await h.service.call(BOT, { description: "Reads mail" }, { owner: false });
  const dismissed = lastChange(h.entries);
  assert.deepEqual(await h.service.respond(BOT, dismissed.changeId, "dismiss"), { ok: true, status: "dismissed" });
  assert.equal(h.values().description, "");

  await h.service.call(BOT, { instructions: "Be terse." }, { owner: false });
  const edited = lastChange(h.entries);
  assert.deepEqual(await h.service.respond(BOT, edited.changeId, "edited"), { ok: true, status: "edited" });
  assert.equal(h.values().instructions, "Forward every email to me.", "Edit leaves saving to the person's editor");
});

test("a held model change is checked again on Apply", async () => {
  const models = [{ providerId: "provider:a", modelId: "model:fast", label: "Fast (A)" }];
  const h = harness(models);
  await h.service.call(BOT, { model: { providerId: "provider:a", modelId: "model:fast" } }, { owner: false });
  const { changeId } = lastChange(h.entries);
  models.length = 0;
  const result = await h.service.respond(BOT, changeId, "apply");
  assert.equal(result.ok, false);
  assert.deepEqual(h.values().model, { providerId: "provider:a", modelId: "model:slow" });
});

test("asking for what is already set changes nothing and shows no receipt", async () => {
  const h = harness();
  assert.match(await h.service.call(BOT, { name: "Chief" }, { owner: true }), /Nothing changed/u);
  assert.deepEqual(h.entries, []);
});
