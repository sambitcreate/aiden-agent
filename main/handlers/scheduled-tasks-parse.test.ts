import assert from "node:assert/strict";
import test from "node:test";
import { parseScheduledTaskInput } from "./scheduled-tasks-parse.js";

const valid = {
  name: "Daily brief",
  mode: "llm",
  cron: "0 9 * * *",
  prompt: "Summarize changes.",
};

test("scheduled task parser accepts exact permission values", () => {
  assert.equal(parseScheduledTaskInput(valid).permission, undefined);
  assert.equal(
    parseScheduledTaskInput({ ...valid, permission: "read-only" }).permission,
    "read-only",
  );
  assert.equal(parseScheduledTaskInput({ ...valid, permission: "full" }).permission, "full");
});

test("scheduled task parser rejects malformed permission values instead of preserving access", () => {
  for (const permission of ["ask", "read_only", "", null, undefined]) {
    assert.throws(
      () => parseScheduledTaskInput({ ...valid, permission }),
      /invalid scheduled task permission/iu,
    );
  }
});

test("renderer task mutations cannot forge the main-owned Assistant execution profile", () => {
  const parsed = parseScheduledTaskInput({
    ...valid,
    executionProfile: "assistant",
  });
  assert.equal("executionProfile" in parsed, false);
});

test("scheduled task parser normalizes a bounded exact MCP server scope", () => {
  assert.deepEqual(
    parseScheduledTaskInput({
      ...valid,
      permission: "full",
      mcpServerIds: [" gmail ", "gmail", "notion"],
    }).mcpServerIds,
    ["gmail", "notion"],
  );
  for (const mcpServerIds of [
    [""],
    [42],
    Array.from({ length: 17 }, (_, index) => `mcp-${index}`),
  ]) {
    assert.throws(
      () => parseScheduledTaskInput({ ...valid, permission: "full", mcpServerIds }),
      /MCP server/iu,
    );
  }
});

test("scheduled task parser carries only an explicit boolean Web Search grant", () => {
  assert.equal(
    parseScheduledTaskInput({ ...valid, webSearchEnabled: true }).webSearchEnabled,
    true,
  );
  assert.equal(
    parseScheduledTaskInput({ ...valid, webSearchEnabled: false }).webSearchEnabled,
    false,
  );
  assert.equal(
    parseScheduledTaskInput({ ...valid, webSearchEnabled: "true" }).webSearchEnabled,
    undefined,
  );
});

test("a desktop save can't choose the chat a task posts into", () => {
  assert.throws(
    () => parseScheduledTaskInput({ ...valid, originChatId: "someone-elses-chat" }),
    /can't be set here/u,
  );
  assert.equal("originChatId" in parseScheduledTaskInput(valid), false);
});

test("a task saved with a trigger needs no cron; null drops the trigger and an invalid one is refused", () => {
  const trigger = {
    kind: "watch",
    source: { type: "url", url: "https://example.com/status" },
    everyMinutes: 15,
  };
  const parsed = parseScheduledTaskInput({
    name: "Status",
    mode: "llm",
    prompt: "What changed?",
    trigger,
  });
  assert.equal(parsed.cron, "");
  assert.deepEqual(parsed.trigger, trigger);
  const cleared = parseScheduledTaskInput({
    name: "Status",
    mode: "llm",
    prompt: "What changed?",
    cron: "0 9 * * *",
    trigger: null,
  });
  assert.equal(cleared.trigger, null);
  assert.equal(cleared.cron, "0 9 * * *");
  assert.equal(
    "trigger" in parseScheduledTaskInput({ name: "Status", mode: "llm", cron: "0 9 * * *" }),
    false,
  );
  assert.throws(
    () =>
      parseScheduledTaskInput({
        name: "Status",
        mode: "llm",
        trigger: { ...trigger, everyMinutes: 1 },
      }),
    /5 to 1440/u,
  );
  assert.throws(
    () => parseScheduledTaskInput({ name: "Status", mode: "llm", trigger: null }),
    /cron/u,
  );
});

test("a connected-app trigger carries only its condition, interval, names and an opaque choice", () => {
  const trigger = {
    kind: "connector",
    everyMinutes: 30,
    condition: { kind: "email", sender: "billing@", unreadOnly: true },
    source: { providerLabel: "iMCP Mail", accountLabel: "me@example.test", resourceLabel: "Inbox" },
    sourceChoiceId: "4C9F5A3E-1D2B-4F6A-9B8C-7D6E5F4A3B2C",
  };
  const parsed = parseScheduledTaskInput({
    name: "Bills",
    mode: "llm",
    prompt: "File new bills.",
    trigger,
  });
  assert.deepEqual(parsed.trigger, {
    ...trigger,
    sourceChoiceId: trigger.sourceChoiceId.toLowerCase(),
  });
  assert.throws(
    () =>
      parseScheduledTaskInput({
        name: "Bills",
        mode: "llm",
        trigger: { ...trigger, everyMinutes: 5 },
      }),
    /15, 30 or 60/u,
  );
  assert.throws(() =>
    parseScheduledTaskInput({
      name: "Bills",
      mode: "llm",
      trigger: { ...trigger, sourceChoiceId: "inbox" },
    }),
  );
  // The private binding never comes from the renderer.
  assert.throws(() =>
    parseScheduledTaskInput({
      name: "Bills",
      mode: "llm",
      trigger: { ...trigger, binding: { serverId: "imcp" } },
    }),
  );
  assert.throws(() =>
    parseScheduledTaskInput({
      name: "Bills",
      mode: "llm",
      trigger: { ...trigger, source: { ...trigger.source, account: "private-id" } },
    }),
  );
  assert.throws(() =>
    parseScheduledTaskInput({
      name: "Soon",
      mode: "llm",
      trigger: {
        ...trigger,
        condition: { kind: "calendar", lookAheadMinutes: 5, timezone: "UTC" },
      },
    }),
  );
});
