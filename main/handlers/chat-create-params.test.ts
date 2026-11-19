import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const source = readFileSync(
    new URL("./chat-create-params.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Object\.keys/u);
  assert.match(source, /count > allowed\.size/u);
});
