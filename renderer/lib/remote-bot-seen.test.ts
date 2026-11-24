import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REMOTE_BOT_SEEN_LIMIT,
  isRemoteBotUnread,
  parseRemoteBotSeen,
  serializeRemoteBotSeen,
  withRemoteBotSeen,
} from "./remote-bot-seen";

test("a paired Mac's Bot reads unread only for a reply newer than the last one shown here, or than the record's start", () => {
  const seen = parseRemoteBotSeen(null, 1_000);
  assert.equal(isRemoteBotUnread(seen, "host/bot", undefined), false, "no reply time, no dot");
  assert.equal(isRemoteBotUnread(seen, "host/bot", 900), false, "a reply from before the record began is not new");
  assert.equal(isRemoteBotUnread(seen, "host/bot", 1_500), true);
  const shown = withRemoteBotSeen(seen, "host/bot", 1_500);
  assert.equal(isRemoteBotUnread(shown, "host/bot", 1_500), false);
  assert.equal(isRemoteBotUnread(shown, "host/bot", 1_600), true);
  assert.equal(isRemoteBotUnread(shown, "other/bot", 1_500), true, "each host's Bot is its own");
  assert.equal(withRemoteBotSeen(shown, "host/bot", 1_200), shown, "the seen time never moves back");
});

test("the record survives a reload and refuses what it can't trust", () => {
  const shown = withRemoteBotSeen(parseRemoteBotSeen(null, 1_000), "host/bot", 1_500);
  assert.deepEqual(parseRemoteBotSeen(serializeRemoteBotSeen(shown), 5_000), shown);
  for (const raw of ["not json", "[]", JSON.stringify({ version: 2, since: 10, seenReplyAt: {} })]) {
    assert.deepEqual(parseRemoteBotSeen(raw, 5_000), { since: 5_000, seenReplyAt: {} }, raw);
  }
  const odd = parseRemoteBotSeen(JSON.stringify({ version: 1, since: 9_000, seenReplyAt: { a: -1, b: "x", c: 7 } }), 5_000);
  assert.deepEqual(odd, { since: 5_000, seenReplyAt: { c: 7 } }, "a start in the future would hide replies, so it is clamped");
  let many = parseRemoteBotSeen(null, 1);
  for (let index = 1; index <= REMOTE_BOT_SEEN_LIMIT + 5; index++) many = withRemoteBotSeen(many, `h/${index}`, index + 10);
  assert.equal(Object.keys(many.seenReplyAt).length, REMOTE_BOT_SEEN_LIMIT, "only the newest are kept");
  assert.equal(many.seenReplyAt["h/1"], undefined);
});
