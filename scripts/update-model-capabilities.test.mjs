/* global AbortSignal, Buffer, Response */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateModelCapabilities, writeSnapshot } from "./update-model-capabilities.mjs";

function capabilitySnapshot() {
  return {
    openai: {
      models: {
        "openai/example": {
          name: "Example",
          limit: { context: 128_000, output: 16_000 },
        },
      },
    },
  };
}

test("the models.dev updater uses the fixed endpoint and atomically replaces the snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-"));
  const destination = path.join(root, "resources", "model-capabilities.json");
  const requests = [];
  const logs = [];
  try {
    const snapshot = capabilitySnapshot();
    const result = await updateModelCapabilities({
      destination,
      fetch: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json" },
        });
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(result, snapshot);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, "https://models.dev/api.json");
    assert.deepEqual(requests[0].init?.headers, { accept: "application/json" });
    assert.equal(requests[0].init?.redirect, "error");
    assert.ok(requests[0].init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), snapshot);
    assert.deepEqual(await readdir(path.dirname(destination)), ["model-capabilities.json"]);
    assert.match(logs[0], /1 providers/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refresh deadline preserves the prior snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-timeout-"));
  const destination = path.join(root, "model-capabilities.json");
  try {
    await writeFile(destination, "prior snapshot\n", "utf8");
    await assert.rejects(
      updateModelCapabilities({
        destination,
        timeoutMs: 10,
        fetch: async () => new Promise(() => undefined),
        log: () => undefined,
      }),
      /release refresh deadline/u,
    );
    assert.equal(await readFile(destination, "utf8"), "prior snapshot\n");
    assert.deepEqual(await readdir(root), ["model-capabilities.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed model fields cannot replace a known-good snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-invalid-"));
  const destination = path.join(root, "model-capabilities.json");
  try {
    await writeFile(destination, "prior snapshot\n", "utf8");
    await assert.rejects(
      updateModelCapabilities({
        destination,
        fetch: async () =>
          new Response(
            JSON.stringify({
              openai: {
                models: {
                  broken: { name: "Broken", modalities: { input: { length: 1 } } },
                },
              },
            }),
          ),
        log: () => undefined,
      }),
      /modalities\.input must be a string array/u,
    );
    assert.equal(await readFile(destination, "utf8"), "prior snapshot\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pretty-print expansion cannot replace a bounded known-good snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-expanded-"));
  const destination = path.join(root, "model-capabilities.json");
  try {
    await writeFile(destination, "prior snapshot\n", "utf8");
    const snapshot = capabilitySnapshot();
    snapshot.openai.unknown = {
      rows: Array.from({ length: 20 }, () => ({ nested: { value: "x" } })),
    };
    const compactBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    const prettyBytes = Buffer.byteLength(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    assert.ok(prettyBytes > compactBytes);

    await assert.rejects(
      writeSnapshot(snapshot, destination, compactBytes),
      /exceeds the packaged snapshot byte limit/u,
    );
    assert.equal(await readFile(destination, "utf8"), "prior snapshot\n");
    assert.deepEqual(await readdir(root), ["model-capabilities.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing diagnostic cannot report a committed snapshot as failed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-log-"));
  const destination = path.join(root, "model-capabilities.json");
  try {
    const snapshot = capabilitySnapshot();
    await assert.doesNotReject(
      updateModelCapabilities({
        destination,
        fetch: async () => new Response(JSON.stringify(snapshot)),
        log: () => {
          throw new Error("stdout closed");
        },
      }),
    );
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), snapshot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed atomic rename removes its temporary snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-model-capabilities-rename-"));
  const destination = path.join(root, "model-capabilities.json");
  try {
    await mkdir(destination);
    await assert.rejects(
      updateModelCapabilities({
        destination,
        fetch: async () => new Response(JSON.stringify(capabilitySnapshot())),
        log: () => undefined,
      }),
    );
    assert.deepEqual(await readdir(root), ["model-capabilities.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
