import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { createBotEventRoutineStore } from "../services/bot-routine-events/store.js";
import { registerBotEventRoutineHandlers } from "./bot-event-routines.js";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function register(link: string | null = "http://mac.local:4567") {
  const root = mkdtempSync(path.join(os.tmpdir(), "aiden-event-ipc-"));
  roots.push(root);
  const store = createBotEventRoutineStore({ profileDir: () => root });
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  registerBotEventRoutineHandlers({
    handle: (channel, handler) => handlers.set(channel, handler as never),
    store,
    linkFor: async (token) => (link ? `${link}/hooks/bot-routines/${token}` : null),
    changed: () => undefined,
  });
  return { invoke: (channel: string, input: unknown) => Promise.resolve(handlers.get(channel)!({}, input)), store };
}

test("creating a link routine returns its link once; listing never shows a token or hash", async () => {
  const h = register();
  const created = await h.invoke("bots:eventRoutines:create", { botId: "bot-a", name: "Orders", prompt: "Summarize.", trigger: { kind: "webhook" } }) as { link: string; token: string };
  assert.match(created.link, /^http:\/\/mac\.local:4567\/hooks\/bot-routines\/[A-Za-z0-9_-]{43}$/u);
  const listed = JSON.stringify(await h.invoke("bots:eventRoutines:list", { botId: "bot-a" }));
  assert.ok(!listed.includes(created.token) && !listed.includes("tokenHash"));
});

test("unknown fields and malformed ids are rejected before the store runs", async () => {
  const h = register();
  await assert.rejects(h.invoke("bots:eventRoutines:create", { botId: "bot-a", name: "x", prompt: "y", trigger: { kind: "webhook" }, tokenHash: "f".repeat(64) }));
  await assert.rejects(h.invoke("bots:eventRoutines:remove", { botId: "bot-a", id: "../x" }));
  assert.deepEqual(await h.store.list("bot-a"), []);
});
