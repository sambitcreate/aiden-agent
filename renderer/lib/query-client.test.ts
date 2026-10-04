import assert from "node:assert/strict";
import test from "node:test";
import { focusManager, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import { createAppQueryClient } from "./query-client.js";

function countingRead() {
  let calls = 0;
  return {
    queryFn: async () => {
      calls += 1;
      return { calls };
    },
    get calls() {
      return calls;
    },
  };
}

async function settle(observer: QueryObserver<unknown, Error>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = observer.getCurrentResult();
    if (!result.isFetching && result.status !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("query never settled");
}

function refocusWindow() {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
}

test("refocusing the window does not re-read active queries unless they opt in", async () => {
  const client = createAppQueryClient();
  client.mount();
  const chat = countingRead();
  const skills = countingRead();
  // A chat is always stale (it re-reads on revisit) but must not re-read on focus.
  const chatObserver = new QueryObserver(client, {
    queryKey: ["chat", "a"],
    queryFn: chat.queryFn,
    staleTime: 0,
  } as QueryObserverOptions<unknown, Error>);
  const skillsObserver = new QueryObserver(client, {
    queryKey: ["skills"],
    queryFn: skills.queryFn,
    staleTime: 0,
    refetchOnWindowFocus: true,
  } as QueryObserverOptions<unknown, Error>);
  const unsubscribe = [chatObserver.subscribe(() => {}), skillsObserver.subscribe(() => {})];
  try {
    await settle(chatObserver);
    await settle(skillsObserver);
    refocusWindow();
    await settle(chatObserver);
    await settle(skillsObserver);
    assert.equal(chat.calls, 1, "focus left the chat alone");
    assert.equal(skills.calls, 2, "opted-in state re-read on focus");
  } finally {
    unsubscribe.forEach((stop) => stop());
    client.unmount();
    client.clear();
    focusManager.setFocused(undefined);
  }
});

test("remounting within the stale window reuses the cached read", async () => {
  const client = createAppQueryClient();
  const settings = countingRead();
  const options = { queryKey: ["settings"], queryFn: settings.queryFn } as QueryObserverOptions<
    unknown,
    Error
  >;
  const first = new QueryObserver(client, options);
  const stopFirst = first.subscribe(() => {});
  await settle(first);
  stopFirst();

  const second = new QueryObserver(client, options);
  const stopSecond = second.subscribe(() => {});
  try {
    const result = await settle(second);
    assert.deepEqual(result.data, { calls: 1 });
    assert.equal(settings.calls, 1);
  } finally {
    stopSecond();
    client.clear();
  }
});

test("a failing read surfaces its error after a single retry", async () => {
  const client = createAppQueryClient();
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["broken"],
    queryFn: async () => {
      calls += 1;
      throw new Error("ipc failed");
    },
    retryDelay: 0,
  } as QueryObserverOptions<unknown, Error>);
  const stop = observer.subscribe(() => {});
  try {
    const result = await settle(observer);
    assert.equal(result.status, "error");
    assert.equal(calls, 2);
  } finally {
    stop();
    client.clear();
  }
});
