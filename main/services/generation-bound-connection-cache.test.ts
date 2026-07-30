import assert from "node:assert/strict";
import test from "node:test";
import {
  closeAgainAfterSettled,
  GenerationBoundConnectionAttempts,
  GenerationBoundConnectionCache,
} from "./generation-bound-connection-cache.js";

test("disconnect invalidates an in-flight connection before it can populate the cache", async () => {
  const cache = new GenerationBoundConnectionCache<{
    id: number;
    transportReady: boolean;
    closedAfterReady: boolean;
  }>();
  let created = 0;
  let staleValue: { id: number; transportReady: boolean; closedAfterReady: boolean } | undefined;
  let releaseConnect!: () => void;
  const connectBarrier = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  const create = () => {
    const value = {
      id: ++created,
      transportReady: false,
      closedAfterReady: false,
    };
    if (value.id === 1) staleValue = value;
    return value;
  };
  const close = async (value: { transportReady: boolean; closedAfterReady: boolean }) => {
    if (value.transportReady) value.closedAfterReady = true;
  };

  const stale = cache.getOrConnect(
    "server",
    create,
    async (value) => {
      await connectBarrier;
      value.transportReady = true;
    },
    close,
  );
  await cache.disconnect("server");
  releaseConnect();
  await assert.rejects(stale, /superseded/u);
  assert.equal(created, 1);
  assert.equal(staleValue?.closedAfterReady, true);

  const current = await cache.getOrConnect(
    "server",
    create,
    async (value) => {
      value.transportReady = true;
    },
    close,
  );
  assert.equal(current.id, 2);
  assert.equal(current.closedAfterReady, false);
  assert.deepEqual(cache.ids(), ["server"]);
  await cache.disconnect("server");
  assert.equal(current.closedAfterReady, true);
  assert.deepEqual(cache.ids(), []);
});

test("a failed connection attempt cannot remain cached as a rejected promise", async () => {
  const cache = new GenerationBoundConnectionCache<{ id: number }>();
  let created = 0;
  const create = () => ({ id: ++created });
  await assert.rejects(
    cache.getOrConnect(
      "server",
      create,
      async () => {
        throw new Error("connect failed");
      },
      async () => undefined,
    ),
    /connect failed/u,
  );

  const retry = await cache.getOrConnect(
    "server",
    create,
    async () => undefined,
    async () => undefined,
  );
  assert.equal(retry.id, 2);
});

test("a retained OAuth-style lease stays current after connect until disconnect", async () => {
  const cache = new GenerationBoundConnectionCache<{ tokenReads: number }>();
  let connectionIsCurrent: (() => boolean) | undefined;
  const client = await cache.getOrConnect(
    "oauth-server",
    () => ({ tokenReads: 0 }),
    async (_value, isCurrent) => {
      connectionIsCurrent = isCurrent;
    },
    async () => undefined,
  );

  const readTokenAfterConnect = () => {
    if (!connectionIsCurrent?.()) throw new Error("OAuth connection lease expired.");
    client.tokenReads += 1;
  };
  readTokenAfterConnect();
  assert.equal(client.tokenReads, 1, "post-connect OAuth reads retain exact cache ownership");

  await cache.disconnect("oauth-server");
  assert.throws(readTokenAfterConnect, /lease expired/u);
});

test("a queue-admitted cache generation cannot start after invalidation", async () => {
  const cache = new GenerationBoundConnectionCache<{ id: number }>();
  const admittedGeneration = cache.generation("server");
  await cache.disconnect("server");
  let created = false;

  await assert.rejects(
    cache.getOrConnect(
      "server",
      () => {
        created = true;
        return { id: 1 };
      },
      async () => undefined,
      async () => undefined,
      admittedGeneration,
    ),
    /superseded/u,
  );
  assert.equal(created, false);
});

test("invalidation during auth resolution prevents a late transport start", async () => {
  const cache = new GenerationBoundConnectionCache<{ id: number }>();
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  let releaseAuth!: () => void;
  const authBarrier = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  let transportStarted = false;
  const pending = cache.getOrConnect(
    "server",
    () => ({ id: 1 }),
    async (_value, isCurrent) => {
      authStarted();
      await authBarrier;
      if (!isCurrent()) throw new Error("The MCP connection was superseded.");
      transportStarted = true;
    },
    async () => undefined,
  );

  await started;
  await cache.disconnect("server");
  releaseAuth();
  await assert.rejects(pending, /superseded/u);
  assert.equal(transportStarted, false);
});

test("one-shot attempts close again after a cancelled connect becomes ready", async () => {
  const attempts = new GenerationBoundConnectionAttempts<{
    ready: boolean;
    closedAfterReady: boolean;
  }>();
  const generation = attempts.generation("server");
  let connectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    connectStarted = resolve;
  });
  let releaseConnect!: () => void;
  const connectBarrier = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let used = false;
  let createdValue: { ready: boolean; closedAfterReady: boolean } | undefined;
  const pending = attempts.run(
    "server",
    generation,
    () => {
      createdValue = { ready: false, closedAfterReady: false };
      return createdValue;
    },
    async (value) => {
      connectStarted();
      await connectBarrier;
      value.ready = true;
    },
    async () => {
      used = true;
    },
    async (value) => {
      if (value.ready) value.closedAfterReady = true;
    },
  );

  await started;
  await attempts.disconnect("server");
  releaseConnect();
  await assert.rejects(pending, /superseded/u);
  assert.equal(used, false);
  assert.equal(createdValue?.closedAfterReady, true);
});

test("post-settlement teardown runs after either resolve or reject", async () => {
  for (const rejects of [false, true]) {
    let release!: () => void;
    const operation = new Promise<void>((resolve, reject) => {
      release = () => (rejects ? reject(new Error("failed")) : resolve());
    });
    let closes = 0;
    closeAgainAfterSettled(operation, async () => {
      closes += 1;
    });
    release();
    await operation.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closes, 1);
  }
});
