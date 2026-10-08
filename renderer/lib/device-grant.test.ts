import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceGrantSource } from "./device-grant.js";

test("a grant is reused until it nears expiry, minted once for concurrent callers, and dropped when refused", async () => {
  let now = 0;
  let minted = 0;
  const source = createDeviceGrantSource(async () => {
    minted += 1;
    return { origin: "http://127.0.0.1:1", token: `t${minted}`, expiresAt: now + 60_000 };
  }, () => now);
  const [first, second] = await Promise.all([source.get(), source.get()]);
  assert.equal(first.token, "t1");
  assert.equal(second.token, "t1");
  assert.equal(minted, 1);

  now = 50_000;
  assert.equal((await source.get()).token, "t1", "ten seconds left is enough");
  now = 56_000;
  assert.equal((await source.get()).token, "t2", "renewed shortly before expiry");
  source.invalidate();
  assert.equal((await source.get()).token, "t3");
});
