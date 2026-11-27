import assert from "node:assert/strict";
import test from "node:test";
import { parseChatCreate } from "./chat-create-params.js";

test("public chat creation uses an exact bounded envelope", () => {
  assert.deepEqual(
    parseChatCreate({
      title: "Review",
      workspaceId: "workspace-1",
      providerId: "provider-1",
      model: "model-1",
    }),
    {
      title: "Review",
      workspaceId: "workspace-1",
      providerId: "provider-1",
      model: "model-1",
    },
  );
  assert.throws(
    () => parseChatCreate({ title: "x".repeat(121) }),
    /Invalid chat title/u,
  );
  assert.throws(() => parseChatCreate({}), /Invalid workspace id/u);
});

test("chat creation rejects excess keys lazily with constant errors", () => {
  const fields: Record<string, unknown> = { workspaceId: "workspace-1" };
  for (let index = 0; index < 10_000; index += 1)
    fields[`extra-${index}`] = index;
  assert.throws(
    () => parseChatCreate(fields),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat creation fields.",
  );

  const proxyKeys = [
    "workspaceId",
    ...Array.from({ length: 1_000 }, (_, index) => `extra-${index}`),
  ];
  let inspected = 0;
  const hostile = new Proxy(
    {},
    {
      ownKeys: () => proxyKeys,
      getOwnPropertyDescriptor(_target, key) {
        inspected += 1;
        return typeof key === "string"
          ? { configurable: true, enumerable: true, value: "workspace-1" }
          : undefined;
      },
    },
  );
  assert.throws(
    () => parseChatCreate(hostile),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid chat creation fields.",
  );
  assert.ok(
    inspected <= 5,
    `expected lazy key rejection, inspected ${inspected} keys`,
  );
});
