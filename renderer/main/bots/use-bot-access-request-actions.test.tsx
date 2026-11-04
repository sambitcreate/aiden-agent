import { installBotTestIpc } from "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "../../components/ui";
import type { BotPendingAccessRequest } from "../../shared/bot-access-requests";
import { useBotAccessRequestActions } from "./use-bot-access-request-actions";

afterEach(cleanup);
const card: BotPendingAccessRequest = {
  botId: "bot:a", waitId: "attempt-1", toolCallId: "call-1", target: "folder", label: "Taxes",
  why: "Prepare your return.", choices: ["not_now", "always", "once"],
};

test("all copies share in-flight counts by Bot and attempt; old completions cannot unlock a newer answer", async () => {
  const releases: Array<(value: { answered: boolean }) => void> = [];
  const calls = installBotTestIpc({ "bots:answerAccessRequest": () => new Promise((resolve) => releases.push(resolve)) });
  const first = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-1"));
  const copy = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-1"));
  const newer = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-2"));
  const other = renderHook(() => useBotAccessRequestActions("bot:b", "attempt-1"));
  let one!: Promise<void>, two!: Promise<void>, three!: Promise<void>;
  act(() => { one = first.result.current.answer(card, "once"); two = copy.result.current.answer(card, "always"); });
  assert.equal(first.result.current.busy, true);
  assert.equal(copy.result.current.busy, true);
  assert.equal(newer.result.current.busy, false);
  assert.equal(other.result.current.busy, false);
  act(() => { three = newer.result.current.answer({ ...card, waitId: "attempt-2" }, "once"); });
  await act(async () => { releases[0]!({ answered: true }); await one; });
  assert.equal(copy.result.current.busy, true, "one finishing still leaves the other answer pending");
  await act(async () => { releases[1]!({ answered: true }); await two; });
  assert.equal(first.result.current.busy, false);
  assert.equal(newer.result.current.busy, true, "the old attempt does not unlock the new one");
  await act(async () => { releases[2]!({ answered: true }); await three; });
  assert.equal(newer.result.current.busy, false);
  assert.deepEqual(calls.map((call) => call.args[0]), [
    { botId: "bot:a", waitId: "attempt-1", choice: "once" },
    { botId: "bot:a", waitId: "attempt-1", choice: "always" },
    { botId: "bot:a", waitId: "attempt-2", choice: "once" },
  ]);
});

test("a server refusal toasts its message and unlocks every copy; an expired answer never reports success", async () => {
  let failure = true;
  installBotTestIpc({ "bots:answerAccessRequest": () => {
    if (failure) throw new Error("Error invoking remote method 'bots:answerAccessRequest': Error: This Bot's access changed. Ask for access again.");
    return { answered: false };
  } });
  const messages: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { messages.push(String(message)); return "toast"; }) as typeof toast.error;
  try {
    const first = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-1"));
    const copy = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-1"));
    await act(() => first.result.current.answer(card, "always"));
    assert.equal(first.result.current.busy, false);
    assert.equal(copy.result.current.busy, false);
    assert.deepEqual(messages, ["This Bot's access changed. Ask for access again."]);
    failure = false;
    await act(() => copy.result.current.answer(card, "once"));
    assert.deepEqual(messages, ["This Bot's access changed. Ask for access again.", "That card was already answered or closed."]);
  } finally { toast.error = original; }
});


test("an Always saved after the task ends reports future access instead of a failed answer", async () => {
  installBotTestIpc({"bots:answerAccessRequest": () => ({answered: true, savedForFuture: true})});
  const successes: string[] = [], failures: string[] = [];
  const savedSuccess = toast.success, savedError = toast.error;
  toast.success = ((message: unknown) => { successes.push(String(message)); return "toast"; }) as typeof toast.success;
  toast.error = ((message: unknown) => { failures.push(String(message)); return "toast"; }) as typeof toast.error;
  try {
    const hook = renderHook(() => useBotAccessRequestActions("bot:a", "attempt-1"));
    await act(() => hook.result.current.answer(card, "always"));
    assert.deepEqual(successes, ["Saved for future tasks."]);
    assert.deepEqual(failures, []);
    assert.equal(hook.result.current.busy, false);
  } finally { toast.success = savedSuccess; toast.error = savedError; }
});
