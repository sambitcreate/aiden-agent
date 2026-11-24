// The default session's webRequest has one owner (§11 item 4, D6): named
// subscribers compose, the first cancel wins, and with no subscriber Electron
// has no listener at all.

import assert from "node:assert/strict";
import test from "node:test";
import { claimDefaultSessionWebRequest } from "./default-session-web-request.js";

type BeforeListener = ((details: unknown, callback: (response: { cancel?: boolean }) => void) => void) | null;
type HeadersListener =
  | ((details: unknown, callback: (response: { responseHeaders?: Record<string, string[]> }) => void) => void)
  | null;

function fakeWebRequest() {
  const calls: string[] = [];
  const target = {
    before: null as BeforeListener,
    headers: null as HeadersListener,
    onBeforeRequest(listener: BeforeListener) {
      calls.push(listener ? "before:set" : "before:null");
      target.before = listener;
    },
    onHeadersReceived(listener: HeadersListener) {
      calls.push(listener ? "headers:set" : "headers:null");
      target.headers = listener;
    },
  };
  return { target, calls };
}

function request(target: { before: BeforeListener }, details: Record<string, unknown> = { url: "https://example.com/" }) {
  let response: { cancel?: boolean } | undefined;
  target.before!(details, (value) => (response = value));
  return response;
}

function headers(target: { headers: HeadersListener }, responseHeaders: Record<string, string[]>) {
  let response: { responseHeaders?: Record<string, string[]> } | undefined;
  target.headers!({ url: "http://127.0.0.1:5173/", responseHeaders }, (value) => (response = value));
  return response;
}

const typed = (target: ReturnType<typeof fakeWebRequest>["target"]) => target as unknown as Parameters<typeof claimDefaultSessionWebRequest>[0];

test("a second claim of the same webRequest throws", () => {
  const { target } = fakeWebRequest();
  claimDefaultSessionWebRequest(typed(target));
  assert.throws(() => claimDefaultSessionWebRequest(typed(target)), /already owned by default-session-web-request\.ts/u);
});

test("with no subscriber no Electron listener is set; the first sets it and removing the last clears it", () => {
  const { target, calls } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target));
  assert.deepEqual(calls, []);
  assert.equal(target.before, null);
  const removeA = dispatcher.onBeforeRequest("a", () => undefined);
  const removeB = dispatcher.onBeforeRequest("b", () => undefined);
  assert.deepEqual(calls, ["before:set"], "one listener for every subscriber");
  removeA();
  assert.deepEqual(calls, ["before:set"]);
  removeB();
  assert.deepEqual(calls, ["before:set", "before:null"]);
  assert.equal(target.before, null);
  const removeHeaders = dispatcher.onHeadersReceived("h", () => undefined);
  removeHeaders();
  assert.deepEqual(calls.slice(2), ["headers:set", "headers:null"]);
});

test("subscribers run in order and the first cancel wins", () => {
  const { target } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target));
  const ran: string[] = [];
  dispatcher.onBeforeRequest("first", () => {
    ran.push("first");
    return undefined;
  });
  dispatcher.onBeforeRequest("second", () => {
    ran.push("second");
    return "cancel";
  });
  dispatcher.onBeforeRequest("third", () => {
    ran.push("third");
    return undefined;
  });
  assert.deepEqual(request(target), { cancel: true });
  assert.deepEqual(ran, ["first", "second"], "a later subscriber doesn't run after a cancel");
});

test("a request nobody cancels proceeds", () => {
  const { target } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target));
  dispatcher.onBeforeRequest("quiet", () => undefined);
  assert.deepEqual(request(target), {});
});

test("a throwing before-request subscriber cancels and logs once a minute; a throwing headers subscriber leaves the headers", () => {
  const { target } = fakeWebRequest();
  const logged: Array<[string, Record<string, unknown>]> = [];
  let now = 0;
  const dispatcher = claimDefaultSessionWebRequest(typed(target), { log: (event, fields) => logged.push([event, fields]), now: () => now });
  dispatcher.onBeforeRequest("broken", () => {
    throw new Error("boom");
  });
  assert.deepEqual(request(target), { cancel: true });
  assert.deepEqual(request(target), { cancel: true });
  assert.equal(logged.length, 1, "logged once within the minute");
  assert.equal(logged[0]![1].subscriber, "broken");
  now = 61_000;
  request(target);
  assert.equal(logged.length, 2, "and again after a minute");

  dispatcher.onHeadersReceived("broken-headers", () => {
    throw new Error("boom");
  });
  assert.deepEqual(headers(target, { A: ["1"] }), {}, "no change");
});

test("headers subscribers chain, each seeing the previous one's headers", () => {
  const { target } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target));
  dispatcher.onHeadersReceived("add-b", (_details, current) => ({ ...current, B: ["2"] }));
  dispatcher.onHeadersReceived("drop-a", (_details, current) => {
    assert.deepEqual(current.B, ["2"], "sees the first subscriber's change");
    const next = { ...current };
    delete next.A;
    return next;
  });
  dispatcher.onHeadersReceived("no-change", () => undefined);
  assert.deepEqual(headers(target, { A: ["1"], C: ["3"] }), { responseHeaders: { B: ["2"], C: ["3"] } });
});

test("a duplicate subscriber name throws", () => {
  const { target } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target));
  dispatcher.onBeforeRequest("design", () => undefined);
  assert.throws(() => dispatcher.onBeforeRequest("design", () => undefined), /design/u);
  dispatcher.onHeadersReceived("design", () => undefined);
  assert.throws(() => dispatcher.onHeadersReceived("design", () => undefined), /design/u);
});

test("with guardSetters a direct call to the target's setters throws, and the dispatcher still installs its listener", () => {
  const { target, calls } = fakeWebRequest();
  const dispatcher = claimDefaultSessionWebRequest(typed(target), { guardSetters: true });
  assert.throws(() => target.onBeforeRequest(() => undefined), /default-session-web-request\.ts/u);
  assert.throws(() => target.onHeadersReceived(() => undefined), /default-session-web-request\.ts/u);
  dispatcher.onBeforeRequest("design", () => "cancel");
  assert.deepEqual(calls, ["before:set"]);
  assert.deepEqual(request(target), { cancel: true });
});
