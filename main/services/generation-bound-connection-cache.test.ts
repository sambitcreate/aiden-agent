import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

test("transport closure evicts the client and expires its lease without revoking configuration", async () => {
  type Client = { id: number; onclose?: () => void; isCurrent?: () => boolean };
  const cache = new GenerationBoundConnectionCache<Client>();
  let created = 0;
  let closes = 0;
  const generation = cache.generation("server");
  const acquire = () => cache.getOrConnect(
    "server",
    () => ({ id: ++created }),
    async (client, isCurrent, onClosed) => {
      client.onclose = onClosed;
      client.isCurrent = isCurrent;
    },
    async (client) => {
      closes += 1;
      client.onclose?.();
    },
    generation,
  );

  const first = await acquire();
  assert.equal(await acquire(), first);
  assert.equal(first.isCurrent?.(), true);
  assert.equal(typeof first.onclose, "function");
  first.onclose?.();
  assert.equal(first.isCurrent?.(), false);
  assert.deepEqual(cache.ids(), []);
  assert.equal(closes, 0, "an SDK close callback must not recursively close the client");
  assert.equal(cache.generation("server"), generation);

  const [second, concurrent] = await Promise.all([acquire(), acquire()]);
  assert.equal(second.id, 2);
  assert.equal(concurrent, second, "recovery deduplicates concurrent discovery");
  first.onclose?.();
  assert.equal(await acquire(), second, "a late old callback cannot evict its replacement");
  assert.equal(second.isCurrent?.(), true);
  await cache.disconnect("server");
  assert.equal(second.isCurrent?.(), false);
  assert.equal(closes, 1);
  await assert.rejects(acquire(), /superseded/u);
});

test("closure during connect cannot publish a dead client or remove a pending replacement", async () => {
  type Client = { id: number; onclose?: () => void };
  const cache = new GenerationBoundConnectionCache<Client>();
  let created = 0;
  const clients: Client[] = [];
  const releases: Array<() => void> = [];
  const acquire = () => cache.getOrConnect(
    "server",
    () => ({ id: ++created }),
    async (client, _isCurrent, onClosed) => {
      client.onclose = onClosed;
      clients.push(client);
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    async (client) => { client.onclose?.(); },
  );

  const first = acquire();
  const rejected = assert.rejects(first, /superseded/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typeof clients[0].onclose, "function");
  clients[0].onclose?.();
  const second = acquire();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clients.length, 2);
  clients[0].onclose?.();
  releases[0]();
  await rejected;
  releases[1]();
  const replacement = await second;
  assert.equal(replacement.id, 2);
  assert.equal(await acquire(), replacement);
  await cache.disconnect("server");
});

test("an immediate close at the end of connect is rejected instead of cached", async () => {
  const cache = new GenerationBoundConnectionCache<object>();
  let closes = 0;
  await assert.rejects(cache.getOrConnect(
    "server",
    () => ({}),
    async (_client, _isCurrent, onClosed) => { onClosed(); },
    async () => { closes += 1; },
  ), /superseded/u);
  assert.deepEqual(cache.ids(), []);
  assert.equal(closes, 1, "failed setup retains its best-effort cleanup");
});

test("real SDK server closure allows the next discovery to establish a fresh session", async (t) => {
  const cache = new GenerationBoundConnectionCache<Client>();
  const servers: Server[] = [];
  t.after(async () => {
    await cache.disconnect("server");
    await Promise.all(servers.map((server) => server.close()));
  });
  const acquire = () => cache.getOrConnect(
    "server",
    () => new Client({ name: "cache-regression", version: "1" }),
    async (client, _isCurrent, onClosed) => {
      client.onclose = onClosed;
      const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
      const session = servers.push(server);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: `session_${session}`, inputSchema: { type: "object" } },
      ] }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    },
    async (client) => client.close(),
  );

  const first = await acquire();
  assert.equal((await first.listTools()).tools[0].name, "session_1");
  await servers[0].close();
  await assert.rejects(first.listTools(), /not connected/i);
  const second = await acquire();
  assert.notEqual(second, first);
  assert.equal((await second.listTools()).tools[0].name, "session_2");
  assert.equal(servers.length, 2);
});
