import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess, spawn } from "node:child_process";
import {
  FormFillHelperClient,
  FormFillHelperError,
  formFillHelperPaths,
} from "./helper-client.js";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: (signal?: string) => boolean;
}

function makeHelperBundle(): { root: string; executable: string } {
  const root = mkdtempSync(path.join(tmpdir(), "form-fill-helper-"));
  const executable = path.join(
    root,
    "Aiden CUA-S1 Forms Helper.app",
    "Contents",
    "MacOS",
    "aiden-cua-s1-forms-helper",
  );
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "#!/bin/true\n");
  return { root, executable };
}

/** A scripted child: captures requests, lets the test drive responses. */
function makeChild(): { child: FakeChild; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line) requests.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return { child, requests };
}

function respond(child: FakeChild, id: string, result: Record<string, unknown>): void {
  child.stdout.write(
    `${JSON.stringify({ version: 1, id, ok: true, result })}\n`,
  );
}

function makeClient() {
  const { root, executable } = makeHelperBundle();
  const spawned: FakeChild[] = [];
  const requestsByChild: Record<string, unknown>[][] = [];
  const spawnImpl = ((command: string) => {
    assert.equal(command, executable);
    const { child, requests } = makeChild();
    spawned.push(child);
    requestsByChild.push(requests);
    return child as unknown as ChildProcess;
  }) as typeof spawn;
  const client = new FormFillHelperClient({
    paths: { appBundle: path.dirname(path.dirname(path.dirname(executable))), executable },
    spawnImpl,
  });
  return { client, spawned, requestsByChild, root };
}

test("helper resolves bundled paths for packaged and dev layouts", () => {
  const paths = formFillHelperPaths("/tmp/base");
  assert.equal(paths.appBundle, "/tmp/base/Aiden CUA-S1 Forms Helper.app");
  assert.equal(
    paths.executable,
    "/tmp/base/Aiden CUA-S1 Forms Helper.app/Contents/MacOS/aiden-cua-s1-forms-helper",
  );
});

test("score sends a versioned request and validates the response", async () => {
  const { client, spawned, requestsByChild, root } = makeClient();
  try {
    const promise = client.score("context", ["a", "b"]);
    assert.equal(requestsByChild[0].length, 1);
    const request = requestsByChild[0][0];
    assert.equal(request.version, 1);
    assert.equal(request.method, "score");
    assert.deepEqual(request.options, ["a", "b"]);
    respond(spawned[0], request.id as string, {
      score: {
        selectedIndex: 1,
        probabilities: [0.2, 0.8],
        rawProbabilities: [0.2, 0.8],
        logits: [0.0, 1.0],
        contextWasTruncated: false,
        truncatedOptionIndices: [],
      },
    });
    const result = await promise;
    assert.equal(result.selectedIndex, 1);
    assert.deepEqual(result.probabilities, [0.2, 0.8]);
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("score rejects option counts below 2 and above 32 without spawning", async () => {
  const { client, spawned, root } = makeClient();
  try {
    await assert.rejects(client.score("c", ["only"]), /32/u);
    await assert.rejects(
      client.score("c", Array.from({ length: 33 }, (_, i) => `o${i}`)),
      /32/u,
    );
    await assert.rejects(client.score("c", []), /32/u);
    assert.equal(spawned.length, 0);
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed helper output poisons the transport and fails in-flight work", async () => {
  const { client, spawned, requestsByChild, root } = makeClient();
  try {
    const promise = client.score("c", ["a", "b"]);
    const request = requestsByChild[0][0];
    spawned[0].stdout.write("not-json\n");
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof FormFillHelperError);
      assert.equal(error.code, "transport");
      return true;
    });
    assert.ok(request.id);
    assert.equal(client.isPoisoned, true);
    // Next request spawns a fresh process (one-restart behavior lives in runtime).
    const second = client.score("c", ["a", "b"]);
    assert.equal(spawned.length, 2);
    const secondRequest = requestsByChild[1][0];
    respond(spawned[1], secondRequest.id as string, {
      score: {
        selectedIndex: 0,
        probabilities: [1, 0],
        rawProbabilities: [1, 0],
        logits: [10, 0],
        contextWasTruncated: true,
        truncatedOptionIndices: [1],
      },
    });
    const result = await second;
    assert.equal(result.selectedIndex, 0);
    assert.equal(result.contextWasTruncated, true);
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper crash rejects in-flight requests", async () => {
  const { client, spawned, root } = makeClient();
  try {
    const promise = client.score("c", ["a", "b"]);
    spawned[0].emit("exit", 1, null);
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof FormFillHelperError);
      assert.equal(error.code, "transport");
      return true;
    });
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("helper error responses map to typed codes", async () => {
  const { client, spawned, requestsByChild, root } = makeClient();
  try {
    const promise = client.score("c", ["a", "b"]);
    const request = requestsByChild[0][0];
    spawned[0].stdout.write(
      `${JSON.stringify({
        version: 1,
        id: request.id,
        ok: false,
        error: { code: "model_not_loaded", message: "no model" },
      })}\n`,
    );
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof FormFillHelperError);
      assert.equal(error.code, "model_not_loaded");
      assert.equal(error.message, "no model");
      return true;
    });
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("score rejects malformed score payloads", async () => {
  const { client, spawned, requestsByChild, root } = makeClient();
  try {
    for (const bad of [
      { selectedIndex: 5, probabilities: [0.5, 0.5], rawProbabilities: [0.5, 0.5], logits: [0, 0], contextWasTruncated: false, truncatedOptionIndices: [] },
      { selectedIndex: 0, probabilities: [0.5, Number.NaN], rawProbabilities: [0.5, 0.5], logits: [0, 0], contextWasTruncated: false, truncatedOptionIndices: [] },
      { selectedIndex: 0, probabilities: [1.5, 0.5], rawProbabilities: [0.5, 0.5], logits: [0, 0], contextWasTruncated: false, truncatedOptionIndices: [] },
      { selectedIndex: 0, probabilities: [0.5], rawProbabilities: [0.5, 0.5], logits: [0, 0], contextWasTruncated: false, truncatedOptionIndices: [] },
    ]) {
      const promise = client.score("c", ["a", "b"]);
      const requests = requestsByChild[0];
      const request = requests[requests.length - 1]!;
      respond(spawned[0], request.id as string, { score: bad });
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof FormFillHelperError);
        assert.equal(error.code, "invalid_output");
        return true;
      });
    }
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("abort signal cancels a pending request", async () => {
  const { client, root } = makeClient();
  try {
    const controller = new AbortController();
    const promise = client.score("c", ["a", "b"], controller.signal);
    controller.abort();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof FormFillHelperError);
      assert.equal(error.code, "cancelled");
      return true;
    });
  } finally {
    client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing helper executable fails closed as unavailable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "form-fill-helper-missing-"));
  try {
    const client = new FormFillHelperClient({
      paths: {
        appBundle: path.join(root, "Aiden CUA-S1 Forms Helper.app"),
        executable: path.join(
          root,
          "Aiden CUA-S1 Forms Helper.app",
          "Contents",
          "MacOS",
          "aiden-cua-s1-forms-helper",
        ),
      },
      spawnImpl: (() => {
        throw new Error("must not spawn");
      }) as typeof spawn,
    });
    await assert.rejects(client.score("c", ["a", "b"]), (error: unknown) => {
      assert.ok(error instanceof FormFillHelperError);
      assert.equal(error.code, "unavailable");
      return true;
    });
    client.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
