import assert from "node:assert/strict";
import test from "node:test";
import { CreateImagesMutationRateLimiter } from "./mutation-rate-limit-core.js";

test("bounds renderer document mutations and recovers after the window", () => {
  let now = 1_000;
  const limiter = new CreateImagesMutationRateLimiter(() => now, 3, 1_000);
  assert.equal(limiter.consume("owner:document"), true);
  assert.equal(limiter.consume("owner:document"), true);
  assert.equal(limiter.consume("owner:document"), true);
  assert.equal(limiter.consume("owner:document"), false);
  assert.equal(limiter.consume("other:document"), true);

  now += 1_001;
  assert.equal(limiter.consume("owner:document"), true);
});

test("fails closed for malformed owner keys and invalid bounds", () => {
  const limiter = new CreateImagesMutationRateLimiter();
  assert.equal(limiter.consume(""), false);
  assert.equal(limiter.consume("x".repeat(769)), false);
  assert.throws(
    () => new CreateImagesMutationRateLimiter(Date.now, 0),
    /capacity/u,
  );
  assert.throws(
    () => new CreateImagesMutationRateLimiter(Date.now, 1, 999),
    /window/u,
  );
  assert.throws(
    () => new CreateImagesMutationRateLimiter(Date.now, 1, 1_000, 0),
    /owner capacity/u,
  );
});

test("charges weighted operations and never grows past the owner bound", () => {
  let now = 1_000;
  const limiter = new CreateImagesMutationRateLimiter(() => now, 10, 1_000, 2);
  assert.equal(limiter.consume("webcontents:1", 8), true);
  assert.equal(limiter.consume("webcontents:1", 3), false);
  assert.equal(limiter.retryAfterMs("webcontents:1"), 0);
  assert.equal(limiter.consume("webcontents:1", 2), true);
  assert.equal(limiter.retryAfterMs("webcontents:1"), 1_000);
  assert.equal(limiter.consume("webcontents:2"), true);
  assert.equal(limiter.consume("webcontents:3"), false);
  assert.equal(limiter.ownerCountForTests(), 2);

  now += 1_001;
  assert.equal(limiter.consume("webcontents:3"), true);
  assert.equal(limiter.ownerCountForTests(), 1);
});
