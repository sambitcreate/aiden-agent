import assert from "node:assert/strict";
import test from "node:test";
import { createMcpOAuthSessionCache, McpOAuthCredentialStorageError } from "./mcp-oauth-session-cache.js";
import type { McpOAuthSession } from "./mcp-oauth-session.js";

/** A fake encrypted store: ciphertext is `enc:<json>`; reads and decrypts are counted. */
function fakeStore(initial: Record<string, McpOAuthSession>) {
  let file: Record<string, unknown> = Object.fromEntries(
    Object.entries(initial).map(([id, session]) => [id, `enc:${JSON.stringify(session)}`]),
  );
  let reads = 0;
  let decrypts = 0;
  let unreadable = false;
  let locked = false;
  let hold: Promise<void> | undefined;
  return {
    source: {
      async readMap() {
        reads += 1;
        if (unreadable) throw new Error("EACCES");
        const snapshot = { ...file };
        const held = hold;
        hold = undefined;
        await held;
        return snapshot;
      },
      decrypt(ciphertext: string) {
        decrypts += 1;
        if (locked) throw new Error("keychain locked");
        return JSON.parse(ciphertext.slice(4)) as McpOAuthSession;
      },
    },
    write(id: string, session: McpOAuthSession) { file = { ...file, [id]: `enc:${JSON.stringify(session)}` }; },
    reads: () => reads,
    decrypts: () => decrypts,
    setUnreadable(value: boolean) { unreadable = value; },
    setLocked(value: boolean) { locked = value; },
    /** The next read snapshots the file now but returns only after `release`. */
    holdNextRead() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      return { release };
    },
  };
}

const tokens = (access: string) => ({ tokens: { access_token: access, token_type: "Bearer" } }) as McpOAuthSession;

test("repeated token reads decrypt once until a write invalidates the cache", async () => {
  const store = fakeStore({ figma: tokens("first") });
  const cache = createMcpOAuthSessionCache(store.source);
  for (let request = 0; request < 5; request += 1) {
    assert.equal((await cache.get("figma")).tokens?.access_token, "first");
  }
  assert.deepEqual([store.reads(), store.decrypts()], [1, 1]);
  assert.deepEqual(await cache.get("never-authorized"), {});
  assert.equal(store.reads(), 1, "an absent entry is answered from the cached map");

  const copy = await cache.get("figma");
  copy.tokens!.access_token = "mutated by caller";
  assert.equal((await cache.get("figma")).tokens?.access_token, "first", "callers receive copies");

  store.write("figma", tokens("rotated"));
  cache.invalidate();
  assert.equal((await cache.get("figma")).tokens?.access_token, "rotated");
  assert.equal(store.reads(), 2);
});

test("a read in flight across an invalidation never repopulates the cache with stale tokens", async () => {
  const store = fakeStore({ figma: tokens("before") });
  const cache = createMcpOAuthSessionCache(store.source);
  const hold = store.holdNextRead();
  const stale = cache.get("figma");
  store.write("figma", tokens("after"));
  cache.invalidate();
  hold.release();
  assert.equal((await stale).tokens?.access_token, "before");
  assert.equal((await cache.get("figma")).tokens?.access_token, "after");
});

test("unreadable storage is a distinct error from never authorized, and is not cached", async () => {
  const store = fakeStore({ figma: tokens("saved") });
  const cache = createMcpOAuthSessionCache(store.source);
  store.setLocked(true);
  await assert.rejects(cache.get("figma"), (error: unknown) =>
    error instanceof McpOAuthCredentialStorageError && /credential storage is unavailable/u.test(error.message));
  assert.deepEqual(await cache.get("other"), {}, "a server that never signed in is still just empty");
  store.setLocked(false);
  assert.equal((await cache.get("figma")).tokens?.access_token, "saved");

  const unreadable = fakeStore({});
  unreadable.setUnreadable(true);
  const failing = createMcpOAuthSessionCache(unreadable.source);
  await assert.rejects(failing.get("figma"), McpOAuthCredentialStorageError);
  unreadable.setUnreadable(false);
  assert.deepEqual(await failing.get("figma"), {});
  assert.equal(unreadable.reads(), 2, "a failed file read is retried");
});
