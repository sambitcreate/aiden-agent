import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BOT_INTERRUPTIONS, parseBotInterruptions, type BotInterruptions } from "../../../renderer/shared/bots.js";
import { decideBotDelivery, quietHoursEnd } from "./gate.js";

const UTC = "UTC";

function decide(at: string, options: { class?: "routine_result" | "issue" | "digest" | "proposal"; sentToday?: number; settings?: BotInterruptions; timeZone?: string } = {}) {
  return decideBotDelivery({
    settings: options.settings ?? DEFAULT_BOT_INTERRUPTIONS,
    class: options.class ?? "routine_result",
    botId: "bot-1",
    now: Date.parse(at),
    timeZone: options.timeZone ?? UTC,
    sentToday: options.sentToday ?? 0,
  });
}

test("defers a routine result at 23:00 until 07:00 the next day", () => {
  assert.deepEqual(decide("2026-10-27T23:00:00Z"), { kind: "defer", until: Date.parse("2026-10-28T07:00:00Z") });
  assert.deepEqual(decide("2026-10-28T03:30:00Z"), { kind: "defer", until: Date.parse("2026-10-28T07:00:00Z") });
  assert.deepEqual(decide("2026-10-28T07:00:00Z"), { kind: "now" });
});

test("quiet hours across the spring DST change still end at 07:00 local", () => {
  // 2027-03-14 02:00 local the clocks jump to 03:00 in New York.
  const at = Date.parse("2027-03-14T06:00:00Z"); // 01:00 EST
  const end = quietHoursEnd(DEFAULT_BOT_INTERRUPTIONS, at, "America/New_York");
  assert.equal(end, Date.parse("2027-03-14T11:00:00Z"), "07:00 EDT");
  assert.equal(decide("2027-03-14T06:00:00Z", { timeZone: "America/New_York" }).kind, "defer");
});

test("issues ignore the daily limit but wait out quiet hours", () => {
  assert.deepEqual(decide("2026-10-27T12:00:00Z", { class: "issue", sentToday: 50 }), { kind: "now" });
  assert.equal(decide("2026-10-27T23:30:00Z", { class: "issue" }).kind, "defer");
});

test("suppresses the sixth routine result of the day with one digest key per day", () => {
  assert.deepEqual(decide("2026-10-27T12:00:00Z", { sentToday: 4 }), { kind: "now" });
  assert.deepEqual(decide("2026-10-27T12:00:00Z", { sentToday: 5 }), { kind: "suppress", reason: "daily_limit", digestKey: "digest:limit:2026-10-27" });
});

test("a digest always goes out", () => {
  assert.deepEqual(decide("2026-10-27T23:30:00Z", { class: "digest", sentToday: 99 }), { kind: "now" });
});

test("quietHours.enabled false never defers", () => {
  const settings = { ...DEFAULT_BOT_INTERRUPTIONS, quietHours: { ...DEFAULT_BOT_INTERRUPTIONS.quietHours, enabled: false } };
  assert.deepEqual(decide("2026-10-27T23:30:00Z", { settings }), { kind: "now" });
});

test("start equal to end means no quiet hours", () => {
  const settings = { ...DEFAULT_BOT_INTERRUPTIONS, quietHours: { enabled: true, start: "09:00", end: "09:00" } };
  assert.deepEqual(decide("2026-10-27T09:30:00Z", { settings }), { kind: "now" });
});

test("a daytime window that does not cross midnight", () => {
  const settings = { ...DEFAULT_BOT_INTERRUPTIONS, quietHours: { enabled: true, start: "12:00", end: "14:00" } };
  assert.deepEqual(decide("2026-10-27T13:00:00Z", { settings }), { kind: "defer", until: Date.parse("2026-10-27T14:00:00Z") });
  assert.deepEqual(decide("2026-10-27T15:00:00Z", { settings }), { kind: "now" });
});

test("parseBotInterruptions rejects 24:00, dailyLimit 21 and extra keys", () => {
  const valid = { quietHours: { enabled: true, start: "22:00", end: "07:00" }, dailyLimit: 5 };
  assert.deepEqual(parseBotInterruptions(valid), valid);
  assert.throws(() => parseBotInterruptions({ ...valid, quietHours: { ...valid.quietHours, end: "24:00" } }));
  assert.throws(() => parseBotInterruptions({ ...valid, dailyLimit: 21 }));
  assert.throws(() => parseBotInterruptions({ ...valid, extra: true }));
  assert.throws(() => parseBotInterruptions({ ...valid, dailyLimit: 1.5 }));
});
