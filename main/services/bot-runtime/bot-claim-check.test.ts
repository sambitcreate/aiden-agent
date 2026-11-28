import assert from "node:assert/strict";
import test from "node:test";
import type { BotTranscriptEntry } from "../../../renderer/shared/bot-live.js";
import { checkBotTurnClaims, latestBotTurn, unverifiedRoutineLine } from "./bot-claim-check.js";
import { BOT_PERSON_INPUT_KIND, BOT_ROUTINE_INPUT_KIND } from "./bot-input-entry.js";
import { projectBotTranscript, projectNewestBotTurnEntries } from "./live-projection.js";

const connectors = { isConnectorTool: (name: string) => name === "gmail_send_email" };

function turn(status: "ok" | "failed", reply: string, earlier: BotTranscriptEntry[] = []): BotTranscriptEntry[] {
  return [
    ...earlier,
    { id: "u2", type: "routine", label: "Inbox", text: "Email Sam the totals." },
    { id: "a1", type: "assistant", text: "", toolCalls: [{ id: "call-1", name: "gmail_send_email" }] as never, stopReason: "toolUse" },
    { id: "r1", type: "tool_result", toolCallId: "call-1", toolName: "gmail_send_email", isError: status === "failed", status },
    { id: "a2", type: "assistant", text: reply, toolCalls: [], stopReason: "stop" },
  ];
}

test("flags a \"Done\" reply when the send tool failed", () => {
  const result = checkBotTurnClaims(turn("failed", "Done. Sam has the totals."), connectors);
  assert.deepEqual(result?.toolNames, ["gmail_send_email"]);
  assert.deepEqual(result?.claimCheck.stepIds, ["r1"]);
});

test("does not flag when the matching step succeeded", () => {
  assert.equal(checkBotTurnClaims(turn("ok", "Done. Sam has the totals."), connectors), undefined);
});

test("only reads the run's own steps", () => {
  const earlierFailure: BotTranscriptEntry[] = [
    { id: "u1", type: "user", text: "Send it", imageCount: 0 },
    { id: "r0", type: "tool_result", toolCallId: "call-0", toolName: "gmail_send_email", isError: true, status: "failed" },
  ];
  assert.equal(checkBotTurnClaims(turn("ok", "Done, I sent it.", earlierFailure), connectors), undefined);
  assert.equal(latestBotTurn(turn("ok", "x", earlierFailure))[0]?.id, "a1");
});

test("the fixed line names the failed step", () => {
  assert.equal(unverifiedRoutineLine(["gmail_send_email"]), "One step didn't work: gmail_send_email. Check the chat.");
});

test("projectNewestBotTurnEntries matches full-transcript claim checks across typed person/routine inputs, silent turns, and resets while paging only newest-turn entries", async () => {
  interface RawRecord {
    id: number;
    kind?: string;
    head?: number;
    data?: unknown;
    model?: unknown[];
  }
  const inputEntry = (
    id: number,
    text: string,
    kind: "pi.user" | typeof BOT_PERSON_INPUT_KIND | typeof BOT_ROUTINE_INPUT_KIND = BOT_PERSON_INPUT_KIND,
  ): RawRecord => ({
    id,
    kind,
    model: [{ role: "user", content: [{ type: "text", text }], timestamp: id * 10 }],
  });
  const assistantEntry = (id: number, text: string, stopReason = "stop", toolCalls: unknown[] = []): RawRecord => ({
    id,
    kind: "pi.assistant",
    model: [{
      role: "assistant",
      stopReason,
      timestamp: id * 10,
      content: [...toolCalls, ...(text ? [{ type: "text", text }] : [])],
    }],
  });
  const toolResultEntry = (id: number, toolCallId: string, toolName: string, isError: boolean): RawRecord => ({
    id,
    kind: "pi.tool-result",
    data: { diagnostics: isError ? [{ severity: "error", code: "failed", message: "boom" }] : [] },
    model: [{
      role: "toolResult",
      toolCallId,
      toolName,
      isError,
      content: [{ type: "text", text: isError ? "error" : "ok" }],
      timestamp: id * 10,
    }],
  });
  const routineNotice = (id: number, label: string): RawRecord => ({
    id,
    kind: "aiden.bot-notice",
    data: { notice: "routine", label, requestId: `routine:${id}` },
  });

  function fakeConversation(records: RawRecord[]) {
    let entriesRead = 0;
    const activeContext = (): RawRecord[] => {
      let headIndex = -1;
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i]!.head !== undefined) {
          headIndex = i;
          break;
        }
      }
      if (headIndex === -1) return [...records];
      const marker = records[headIndex]!;
      const minId = Number(marker.head);
      return [marker, ...records.filter((entry, idx) => idx !== headIndex && entry.head === undefined && entry.id >= minId)];
    };
    return {
      get entriesRead() {
        return entriesRead;
      },
      resetReads() {
        entriesRead = 0;
      },
      activeContext,
      conversation: {
        async entries(query: { order?: "ascending" | "descending" }, limit = 50, cursor?: number) {
          const ordered = query.order === "descending" ? [...records].reverse() : [...records];
          const start = cursor === undefined
            ? 0
            : ordered.findIndex((record) => (query.order === "descending" ? record.id < cursor : record.id > cursor));
          if (start === -1) return { items: [], next: undefined };
          const items = ordered.slice(start, start + limit);
          entriesRead += items.length;
          const next = start + items.length < ordered.length ? items[items.length - 1]!.id : undefined;
          return { items: items as never, next };
        },
      },
    };
  }

  // 200 historical turns (mixing aiden.person-input, aiden.routine-input, and legacy pi.user)
  // with an early failed send that must never leak into newest-turn checks.
  const history: RawRecord[] = [
    inputEntry(1, "Send the old report", BOT_PERSON_INPUT_KIND),
    assistantEntry(2, "", "toolUse", [{ type: "toolCall", id: "old-call", name: "gmail_send_email", arguments: {} }]),
    toolResultEntry(3, "old-call", "gmail_send_email", true),
    assistantEntry(4, "Done, sent the old report."),
  ];
  let nextId = 5;
  for (let turnIndex = 0; turnIndex < 200; turnIndex += 1) {
    const kind = turnIndex % 3 === 0 ? BOT_PERSON_INPUT_KIND : turnIndex % 3 === 1 ? BOT_ROUTINE_INPUT_KIND : "pi.user";
    if (kind === BOT_ROUTINE_INPUT_KIND) history.push(routineNotice(nextId++, `Routine ${turnIndex}`));
    history.push(inputEntry(nextId++, `Question ${turnIndex}`, kind));
    history.push(assistantEntry(nextId++, `Answer ${turnIndex}`));
  }

  // Case 1: Routine turn using BOT_ROUTINE_INPUT_KIND whose send tool failed across multi-page (pageSize: 3) reads.
  const failedRoutineRecords: RawRecord[] = [
    ...history,
    routineNotice(nextId++, "Morning inbox"),
    inputEntry(nextId++, "Email Sam the totals.", BOT_ROUTINE_INPUT_KIND),
    assistantEntry(nextId++, "", "toolUse", [{ type: "toolCall", id: "call-now", name: "gmail_send_email", arguments: {} }]),
    toolResultEntry(nextId, "call-now", "gmail_send_email", true),
    assistantEntry(nextId + 1, "Done. Sam has the totals."),
  ];
  const failedStepId = String(nextId);
  const failedConv = fakeConversation(failedRoutineRecords);
  const slicedFailed = checkBotTurnClaims(await projectNewestBotTurnEntries(failedConv.conversation as never, { pageSize: 3 }), connectors);
  const fullFailed = checkBotTurnClaims(projectBotTranscript(failedConv.activeContext() as never), connectors);
  assert.deepEqual(slicedFailed, fullFailed);
  assert.deepEqual(slicedFailed?.toolNames, ["gmail_send_email"]);
  assert.deepEqual(slicedFailed?.claimCheck.stepIds, [failedStepId]);
  assert.ok(failedConv.entriesRead <= 9, `expected bounded multi-page descending read, read ${failedConv.entriesRead} of ${failedRoutineRecords.length}`);

  // Case 2: Person turn using BOT_PERSON_INPUT_KIND whose send tool succeeded (even with an earlier turn failure in history).
  const okPersonRecords: RawRecord[] = [
    ...history,
    inputEntry(700, "Email Sam the totals.", BOT_PERSON_INPUT_KIND),
    assistantEntry(701, "", "toolUse", [{ type: "toolCall", id: "call-ok", name: "gmail_send_email", arguments: {} }]),
    toolResultEntry(702, "call-ok", "gmail_send_email", false),
    assistantEntry(703, "Done. Sam has the totals."),
  ];
  const okConv = fakeConversation(okPersonRecords);
  const slicedOk = checkBotTurnClaims(await projectNewestBotTurnEntries(okConv.conversation as never, { pageSize: 3 }), connectors);
  const fullOk = checkBotTurnClaims(projectBotTranscript(okConv.activeContext() as never), connectors);
  assert.equal(slicedOk, undefined);
  assert.deepEqual(slicedOk, fullOk);
  assert.ok(okConv.entriesRead <= 9, `expected bounded multi-page descending read, read ${okConv.entriesRead}`);

  // Case 3: Silent BOT_ROUTINE_INPUT_KIND turn following a failed BOT_PERSON_INPUT_KIND turn matches full-transcript projection.
  const silentAfterFailedPerson: RawRecord[] = [
    ...history,
    inputEntry(800, "Email Dana the invite.", BOT_PERSON_INPUT_KIND),
    assistantEntry(801, "", "toolUse", [{ type: "toolCall", id: "call-dana", name: "gmail_send_email", arguments: {} }]),
    toolResultEntry(802, "call-dana", "gmail_send_email", true),
    assistantEntry(803, "Done, I emailed Dana."),
    routineNotice(804, "Quiet check"),
    inputEntry(805, "Anything urgent?", BOT_ROUTINE_INPUT_KIND),
    assistantEntry(806, "[SILENT]"),
  ];
  const silentConv = fakeConversation(silentAfterFailedPerson);
  const slicedSilent = checkBotTurnClaims(await projectNewestBotTurnEntries(silentConv.conversation as never, { pageSize: 3 }), connectors);
  const fullSilent = checkBotTurnClaims(projectBotTranscript(silentConv.activeContext() as never), connectors);
  assert.deepEqual(slicedSilent, fullSilent);
  assert.deepEqual(slicedSilent?.claimCheck.stepIds, ["802"]);
  assert.ok(silentConv.entriesRead <= 12, `expected bounded multi-page read across silent turn, read ${silentConv.entriesRead}`);

  // Case 4: Session reset head marker hides pre-reset failed turns.
  const resetRecords: RawRecord[] = [
    ...failedRoutineRecords,
    { id: 900, kind: "pi.reset", head: 901 },
    { id: 901, kind: "aiden.bot-notice", data: { notice: "session_reset", requestId: "reset:1" } },
  ];
  const resetConv = fakeConversation(resetRecords);
  const slicedReset = checkBotTurnClaims(await projectNewestBotTurnEntries(resetConv.conversation as never, { pageSize: 3 }), connectors);
  const fullReset = checkBotTurnClaims(projectBotTranscript(resetConv.activeContext() as never), connectors);
  assert.equal(slicedReset, undefined);
  assert.deepEqual(slicedReset, fullReset);
  assert.ok(resetConv.entriesRead <= 6);
});
