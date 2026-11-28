import assert from "node:assert/strict";
import test from "node:test";

import {
  audienceReportsAnalytics,
  chatAudience,
  chatAudienceLead,
  isChatAudience,
} from "./audience.js";

test("a lead chat's audience names its lead and nothing else does", () => {
  const audience = chatAudience("lead-1");
  assert.equal(isChatAudience(audience), true);
  assert.equal(chatAudienceLead(audience), "lead-1");
  assert.equal(chatAudienceLead("device-1"), undefined);
  assert.equal(chatAudienceLead("chat:../escape"), undefined);
  assert.throws(() => chatAudience("../escape"));
});

test("a chat audience reports no analytics even with no device record; apps never do; phones do", () => {
  const devices = [
    { id: "phone-1", type: "iphone" },
    { id: "app-1", type: "agent" },
  ];
  assert.equal(audienceReportsAnalytics(chatAudience("lead-1"), devices), false);
  assert.equal(
    audienceReportsAnalytics(chatAudience("lead-1"), [{ id: "chat:lead-1", type: "iphone" }]),
    false,
  );
  assert.equal(audienceReportsAnalytics("app-1", devices), false);
  assert.equal(audienceReportsAnalytics("phone-1", devices), true);
});
