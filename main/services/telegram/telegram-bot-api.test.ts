import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TelegramApiError,
  createFetchTransport,
  TelegramBotApi,
  type TelegramApiResponse,
  type TelegramTransport,
  type TelegramUpdate,
  type TelegramUser,
} from "./telegram-bot-api.js";

/** Build an api backed by a recording transport that always returns `response`. */
function harness(response: TelegramApiResponse<unknown>): {
  api: TelegramBotApi;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const transport: TelegramTransport = async (method, body) => {
    calls.push({ method, body });
    return response;
  };
  return { api: new TelegramBotApi(transport), calls };
}

test("getUpdates calls transport with offset, timeout, and allowed_updates", async () => {
  const updates: TelegramUpdate[] = [{ update_id: 7, message: undefined }];
  const { api, calls } = harness({ ok: true, result: updates });
  const result = await api.getUpdates(42, 25);

  assert.deepEqual(result, updates);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "getUpdates");
  assert.deepEqual(calls[0].body, {
    timeout: 25,
    allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
    offset: 42,
  });
});

test("getUpdates without offset omits the offset field", async () => {
  const { api, calls } = harness({ ok: true, result: [] });
  await api.getUpdates(undefined, 0);

  assert.equal(calls[0].method, "getUpdates");
  assert.deepEqual(calls[0].body, {
    timeout: 0,
    allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
  });
  assert.equal("offset" in calls[0].body, false);
});

test("getMe returns the user from a successful response", async () => {
  const user: TelegramUser = {
    id: 99,
    is_bot: true,
    first_name: "Aiden",
    username: "aiden_bot",
  };
  const { api, calls } = harness({ ok: true, result: user });
  const me = await api.getMe();

  assert.deepEqual(me, user);
  assert.equal(calls[0].method, "getMe");
  assert.deepEqual(calls[0].body, {});
});

test("sendMessage builds body with chat_id, text, and parse_mode", async () => {
  const { api, calls } = harness({
    ok: true,
    result: { message_id: 1, chat: { id: 5, type: "private" }, date: 0 },
  });
  await api.sendMessage({ chatId: 5, text: "hello", parseMode: "HTML" });

  assert.equal(calls[0].method, "sendMessage");
  assert.deepEqual(calls[0].body, { chat_id: 5, text: "hello", parse_mode: "HTML" });
});

test("sendMessage omits parse_mode when it is not provided", async () => {
  const { api, calls } = harness({
    ok: true,
    result: { message_id: 1, chat: { id: 5, type: "private" }, date: 0 },
  });
  await api.sendMessage({ chatId: 5, text: "hello" });

  assert.deepEqual(calls[0].body, { chat_id: 5, text: "hello" });
  assert.equal("parse_mode" in calls[0].body, false);
});

test("API error (ok: false) throws TelegramApiError with description and error_code", async () => {
  const { api } = harness({ ok: false, description: "Unauthorized", error_code: 401 });
  await assert.rejects(
    () => api.getMe(),
    (err: unknown) => {
      assert.ok(err instanceof TelegramApiError, "expected TelegramApiError");
      assert.equal((err as TelegramApiError).message, "Unauthorized");
      assert.equal((err as TelegramApiError).code, 401);
      assert.equal((err as TelegramApiError).retryAfter, undefined);
      return true;
    },
  );
});

test("TelegramApiError carries retryAfter from parameters.retry_after", async () => {
  const { api } = harness({
    ok: false,
    description: "Too Many Requests",
    error_code: 429,
    parameters: { retry_after: 30 },
  });
  await assert.rejects(
    () => api.getMe(),
    (err: unknown) => {
      assert.ok(err instanceof TelegramApiError);
      assert.equal((err as TelegramApiError).retryAfter, 30);
      assert.equal((err as TelegramApiError).code, 429);
      return true;
    },
  );
});

test("sendChatAction calls transport with chat_id and action", async () => {
  const { api, calls } = harness({ ok: true, result: true });
  await api.sendChatAction(7, "typing");

  assert.equal(calls[0].method, "sendChatAction");
  assert.deepEqual(calls[0].body, { chat_id: 7, action: "typing" });
});

test("native rich messages and drafts preserve thread routing", async () => {
  const { api, calls } = harness({
    ok: true,
    result: { message_id: 1, chat: { id: 5, type: "private" }, date: 0 },
  });
  await api.sendRichMessage({ chatId: 5, threadId: 8, markdown: "**Hello**" });
  assert.deepEqual(calls[0], {
    method: "sendRichMessage",
    body: {
      chat_id: 5,
      message_thread_id: 8,
      rich_message: { markdown: "**Hello**", skip_entity_detection: true },
    },
  });

  const draft = harness({ ok: true, result: true });
  await draft.api.sendRichMessageDraft({ chatId: 5, threadId: 8, draftId: 9, markdown: "Draft" });
  assert.equal(draft.calls[0]?.method, "sendRichMessageDraft");
  assert.equal(draft.calls.length, 1);
});

test("answerCallbackQuery includes callback_query_id and optional text", async () => {
  const withoutText = harness({ ok: true, result: true });
  await withoutText.api.answerCallbackQuery("cq-1");
  assert.equal(withoutText.calls[0].method, "answerCallbackQuery");
  assert.deepEqual(withoutText.calls[0].body, { callback_query_id: "cq-1" });

  const withText = harness({ ok: true, result: true });
  await withText.api.answerCallbackQuery("cq-2", "Acknowledged");
  assert.deepEqual(withText.calls[0].body, {
    callback_query_id: "cq-2",
    text: "Acknowledged",
  });
});

test("getUpdates with an already-aborted signal rejects immediately without calling transport", async () => {
  let called = false;
  const transport: TelegramTransport = async () => {
    called = true;
    return { ok: true, result: [] };
  };
  const api = new TelegramBotApi(transport);

  await assert.rejects(() => api.getUpdates(undefined, 0, AbortSignal.abort()), /aborted/i);
  assert.equal(called, false, "transport must not be invoked for an aborted signal");
});


test("command menu updates have a bounded request without altering long-poll transport", async (t) => {
  const signals: Array<AbortSignal | null | undefined> = [];
  const timeouts: number[] = [];
  const signal = new AbortController().signal;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => { timeouts.push(milliseconds); return signal; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    signals.push(options?.signal);
    return { json: async () => ({ ok: true, result: true }) };
  });
  const transport = createFetchTransport(async () => "test-token");
  await transport("setMyCommands", { commands: [] });
  await transport("getUpdates", { timeout: 25 });
  assert.deepEqual(timeouts, [10_000]);
  assert.equal(signals[0], signal);
  assert.equal(signals[1], undefined);
});
