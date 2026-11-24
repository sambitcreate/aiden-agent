import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotTranscriptEntry } from "../shared/bot-live";
import {
  REMOTE_BOT_SEEN_LIMIT,
  isRemoteBotUnread,
  parseRemoteBotSeen,
  remoteBotShownReplyAt,
  serializeRemoteBotSeen,
  withRemoteBotHostListed,
  withRemoteBotSeen,
} from "./remote-bot-seen";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 9);

test("a paired Mac's Bot reads unread only for a reply newer than the last one shown here, or than its host's first listing", () => {
  let seen = parseRemoteBotSeen(null);
  assert.equal(isRemoteBotUnread(seen, "host", "bot", NOW), false, "nothing to compare with before the host is listed");
  seen = withRemoteBotHostListed(seen, "host", [NOW - 5_000, undefined, NOW]);
  assert.equal(isRemoteBotUnread(seen, "host", "bot", undefined), false, "no reply time, no dot");
  assert.equal(isRemoteBotUnread(seen, "host", "bot", NOW - 5_000), false, "a reply from before the first listing is not new");
  assert.equal(isRemoteBotUnread(seen, "host", "bot", NOW + 500), true);
  assert.equal(withRemoteBotHostListed(seen, "host", [NOW + 9_000]), seen, "a host's baseline is set once");
  const shown = withRemoteBotSeen(seen, "host/bot", NOW + 500);
  assert.equal(isRemoteBotUnread(shown, "host", "bot", NOW + 500), false);
  assert.equal(isRemoteBotUnread(shown, "host", "bot", NOW + 600), true);
  assert.equal(isRemoteBotUnread(shown, "other", "bot", NOW + 500), false, "each host has its own baseline");
  assert.equal(withRemoteBotSeen(shown, "host/bot", NOW + 200), shown, "the seen time never moves back");
  assert.equal(withRemoteBotHostListed(seen, "quiet", []), seen, "a host with no Bots listed yet sets no baseline");
});

test("a host whose Bots hadn't replied when first listed shows a dot for their first reply, also after a reload", () => {
  let seen = withRemoteBotHostListed(parseRemoteBotSeen(null), "quiet", [undefined, undefined]);
  // The next feed update brings the first reply; listing again must not swallow it.
  seen = withRemoteBotHostListed(seen, "quiet", [NOW]);
  assert.equal(isRemoteBotUnread(seen, "quiet", "bot", NOW), true);
  const reloaded = parseRemoteBotSeen(serializeRemoteBotSeen(seen));
  assert.equal(isRemoteBotUnread(withRemoteBotHostListed(reloaded, "quiet", [NOW]), "quiet", "bot", NOW), true);
  assert.equal(isRemoteBotUnread(withRemoteBotSeen(reloaded, "quiet/bot", NOW), "quiet", "bot", NOW), false);
});

test("a host whose clock is an hour ahead or behind this Mac still starts read and shows its next reply", () => {
  for (const skew of [HOUR, -HOUR]) {
    const hostNow = NOW + skew;
    const listed = withRemoteBotHostListed(parseRemoteBotSeen(null), "host", [hostNow - 60_000, hostNow - 120_000]);
    assert.equal(isRemoteBotUnread(listed, "host", "scout", hostNow - 60_000), false, `skew ${skew}: the reply already there is read`);
    assert.equal(isRemoteBotUnread(listed, "host", "planner", hostNow - 120_000), false, `skew ${skew}: so is an older one`);
    assert.equal(isRemoteBotUnread(listed, "host", "scout", hostNow + 1_000), true, `skew ${skew}: the next reply shows a dot`);
    assert.equal(isRemoteBotUnread(listed, "host", "newbot", hostNow + 1_000), true, `skew ${skew}: so does a new Bot's first reply`);
  }
});

test("only a reply the remote chat shows counts as seen", () => {
  const user = (id: string, at: number): BotTranscriptEntry => ({ id, type: "user", text: "Hi", imageCount: 0, at });
  const reply = (id: string, at: number): BotTranscriptEntry => ({ id, type: "assistant", text: "Hello", toolCalls: [], stopReason: "stop", at });
  assert.equal(remoteBotShownReplyAt(undefined, NOW), null, "nothing read yet, nothing seen");
  assert.equal(remoteBotShownReplyAt([], NOW), null);
  const older = [user("u1", NOW - 3_000), reply("a1", NOW - 2_000)];
  assert.equal(remoteBotShownReplyAt(older, NOW), NOW - 2_000, "an older snapshot shows only its own newest reply");
  assert.equal(remoteBotShownReplyAt([...older, reply("a2", NOW)], NOW), NOW, "the feed's reply once the chat shows it");
  assert.equal(
    remoteBotShownReplyAt([...older, reply("a2", NOW), user("u2", NOW + 10)], NOW),
    NOW,
    "a later message does not claim more than the feed's reply",
  );
  assert.equal(remoteBotShownReplyAt([user("u1", NOW)], undefined), null, "no reply shown, none seen");
});

test("the record survives a reload and refuses what it can't trust", () => {
  const listed = withRemoteBotHostListed(parseRemoteBotSeen(null), "host", [NOW]);
  const shown = withRemoteBotSeen(listed, "host/bot", NOW + 1);
  assert.deepEqual(parseRemoteBotSeen(serializeRemoteBotSeen(shown)), shown);
  for (const raw of ["not json", "[]", JSON.stringify({ version: 1, since: 10, seenReplyAt: { "host/bot": 5 } })]) {
    assert.deepEqual(parseRemoteBotSeen(raw), { hostSince: {}, seenReplyAt: {} }, raw);
  }
  const odd = parseRemoteBotSeen(JSON.stringify({ version: 2, hostSince: { h: "x", g: 4, z: 0, n: -1 }, seenReplyAt: { a: -1, b: "x", c: 7, d: 0 } }));
  assert.deepEqual(odd, { hostSince: { g: 4, z: 0 }, seenReplyAt: { c: 7 } });
  let many = parseRemoteBotSeen(null);
  for (let index = 1; index <= REMOTE_BOT_SEEN_LIMIT + 5; index++) many = withRemoteBotSeen(many, `h/${index}`, index + 10);
  assert.equal(Object.keys(many.seenReplyAt).length, REMOTE_BOT_SEEN_LIMIT, "only the newest are kept");
  assert.equal(many.seenReplyAt["h/1"], undefined);
});
