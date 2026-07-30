import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
  NO_ENABLED_MCP_RECOVERY_REPLY,
  UNVERIFIED_TARGET_RECOVERY_REPLY,
  advanceAttendedToolErrorState,
  attendedToolRecoveryMessage,
  recoverAttendedToolErrorContext,
} from "./tool-loop-guard.js";

test("attended tool errors allow one correction and stop the second failed turn", () => {
  const first = advanceAttendedToolErrorState(0, [{ isError: true }]);
  assert.deepEqual(first, {
    consecutiveErrorTurns: 1,
    shouldStop: false,
  });

  const second = advanceAttendedToolErrorState(first.consecutiveErrorTurns, [{ isError: true }]);
  assert.deepEqual(second, {
    consecutiveErrorTurns: MAX_CONSECUTIVE_ATTENDED_TOOL_ERROR_TURNS,
    shouldStop: true,
  });
});

test("a successful or text-only turn resets the attended tool error streak", () => {
  assert.deepEqual(advanceAttendedToolErrorState(1, [{ isError: false }]), {
    consecutiveErrorTurns: 0,
    shouldStop: false,
  });
  assert.deepEqual(advanceAttendedToolErrorState(1, []), {
    consecutiveErrorTurns: 0,
    shouldStop: false,
  });
});

test("repeated attended tool errors recover with one host-directed text-only turn", () => {
  const context = recoverAttendedToolErrorContext(
    {
      systemPrompt: "Aiden",
      messages: [{ role: "user", content: "Create a briefing", timestamp: 1 }],
      tools: [{ name: "schedule_task" } as never],
    },
    false,
    2,
  );
  assert.deepEqual(context.tools, []);
  assert.deepEqual(context.messages[context.messages.length - 1], {
    role: "user",
    content: attendedToolRecoveryMessage(false),
    timestamp: 2,
  });
  assert.match(attendedToolRecoveryMessage(false), /exactly this text/iu);
  assert.match(attendedToolRecoveryMessage(false), /Settings → MCP Servers/u);
  assert.match(attendedToolRecoveryMessage(false), new RegExp(NO_ENABLED_MCP_RECOVERY_REPLY, "u"));
  assert.match(
    attendedToolRecoveryMessage(true),
    new RegExp(UNVERIFIED_TARGET_RECOVERY_REPLY, "u"),
  );
});
