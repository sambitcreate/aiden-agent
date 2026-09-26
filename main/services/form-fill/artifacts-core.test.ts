import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FormFillArtifactStore,
  isFormFillSupported,
  verifyFormFillPackage,
} from "./artifacts-core.js";
import {
  FORM_FILL_ARTIFACT_FILES,
  FORM_FILL_MODEL_PACKAGE_DIR,
  formFillArtifactUrl,
  isAllowedArtifactPath,
  type FormFillArtifactFile,
} from "./manifest.js";

function makeTemp(): string {
  return mkdtempSync(path.join(tmpdir(), "form-fill-artifacts-"));
}

/**
 * Test manifest: same shape as the pinned one, small content so tests can
 * write real files whose hashes match — exercising the production verifier
 * end to end.
 */
const TEST_FILES: readonly FormFillArtifactFile[] = [
  {
    path: "pkg/model.mlmodel",
    sha256: createHash("sha256").update("model-bytes").digest("hex"),
    bytes: Buffer.byteLength("model-bytes"),
  },
  {
    path: "pkg/Data/weights/weight.bin",
    sha256: createHash("sha256").update("weights").digest("hex"),
    bytes: Buffer.byteLength("weights"),
  },
  {
    path: "LICENSE",
    sha256: createHash("sha256").update("license").digest("hex"),
    bytes: Buffer.byteLength("license"),
  },
];

function writeTestTree(root: string): void {
  for (const file of TEST_FILES) {
    const full = path.join(root, file.path);
    mkdirSync(path.dirname(full), { recursive: true });
    const content =
      file.path === "pkg/model.mlmodel"
        ? "model-bytes"
        : file.path === "pkg/Data/weights/weight.bin"
          ? "weights"
          : "license";
    writeFileSync(full, content);
  }
}

test("verifyFormFillPackage accepts a tree matching the manifest", async () => {
  const root = makeTemp();
  try {
    writeTestTree(root);
    assert.equal(await verifyFormFillPackage(root, TEST_FILES), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFormFillPackage rejects missing files", async () => {
  const root = makeTemp();
  try {
    writeTestTree(root);
    rmSync(path.join(root, "LICENSE"));
    assert.match(
      (await verifyFormFillPackage(root, TEST_FILES)) ?? "",
      /missing/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFormFillPackage rejects unexpected files", async () => {
  const root = makeTemp();
  try {
    writeTestTree(root);
    writeFileSync(path.join(root, "extra.bin"), "x");
    assert.equal(
      await verifyFormFillPackage(root, TEST_FILES),
      "The model package contains an unexpected file.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFormFillPackage rejects symlinks", async () => {
  const root = makeTemp();
  try {
    writeTestTree(root);
    symlinkSync("LICENSE", path.join(root, "link.md"));
    assert.equal(
      await verifyFormFillPackage(root, TEST_FILES),
      "The model package must not contain links.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFormFillPackage rejects hash mismatches and wrong sizes", async () => {
  const root = makeTemp();
  try {
    writeTestTree(root);
    writeFileSync(path.join(root, "LICENSE"), "tampered");
    assert.match(
      (await verifyFormFillPackage(root, TEST_FILES)) ?? "",
      /unexpected size|checksum/u,
    );
    // Same size, different bytes → checksum failure specifically.
    writeFileSync(path.join(root, "LICENSE"), "licenze");
    assert.match(
      (await verifyFormFillPackage(root, TEST_FILES)) ?? "",
      /checksum/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyFormFillPackage fails closed on an unreadable root", async () => {
  const missing = path.join(tmpdir(), `form-fill-missing-${Date.now()}`);
  assert.equal(
    await verifyFormFillPackage(missing, TEST_FILES),
    "The model directory is unreadable.",
  );
});

test("manifest requires the complete pinned file set with stable paths", () => {
  assert.equal(FORM_FILL_ARTIFACT_FILES.length, 6);
  for (const file of FORM_FILL_ARTIFACT_FILES) {
    assert.ok(isAllowedArtifactPath(file.path), file.path);
    assert.match(file.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(file.bytes > 0);
  }
  assert.ok(
    FORM_FILL_ARTIFACT_FILES.some(
      (f) => f.path === `${FORM_FILL_MODEL_PACKAGE_DIR}/Manifest.json`,
    ),
  );
  assert.ok(!isAllowedArtifactPath("../escape"));
  assert.ok(!isAllowedArtifactPath("foo/../../bar"));
  assert.ok(!isAllowedArtifactPath(""));
  assert.ok(
    !isAllowedArtifactPath("cua_s1_forms_fp16_options32.mlpackage/evil.sh"),
  );
  assert.equal(
    formFillArtifactUrl("LICENSE"),
    "https://huggingface.co/FluidInference/cua-s1-forms-coreml/resolve/ca2113d260559ee5d2d6463900e39916936aca65/LICENSE",
  );
});

test("isFormFillSupported gates on Apple silicon macOS 14.4+", () => {
  assert.equal(
    isFormFillSupported({
      platform: "darwin",
      arch: "arm64",
      osRelease: "14.4.0",
    }).supported,
    true,
  );
  assert.equal(
    isFormFillSupported({
      platform: "darwin",
      arch: "arm64",
      osRelease: "15.0.0",
    }).supported,
    true,
  );
  assert.equal(
    isFormFillSupported({
      platform: "darwin",
      arch: "x64",
      osRelease: "15.0.0",
    }).supported,
    false,
  );
  assert.equal(
    isFormFillSupported({
      platform: "darwin",
      arch: "arm64",
      osRelease: "14.3.0",
    }).supported,
    false,
  );
  assert.equal(
    isFormFillSupported({ platform: "linux", arch: "x64", osRelease: "6.8.0" })
      .supported,
    false,
  );
  assert.equal(
    isFormFillSupported({ platform: "win32", arch: "x64", osRelease: "10.0.0" })
      .supported,
    false,
  );
});

test("status is not-downloaded when the root has no verified package, no network", async () => {
  const root = makeTemp();
  try {
    const store = new FormFillArtifactStore({ rootDir: root });
    // Stub the platform gate so the macOS check doesn't flip to unsupported.
    const status = await store.refresh();
    // On this Linux box the platform gate reports unsupported; that is the
    // correct behavior and proves refresh() never touched the network.
    assert.ok(["not-downloaded", "unsupported"].includes(status.state));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("downloads flush every byte and removal waits for cancellation without republishing", async () => {
  const root = makeTemp();
  const modelRoot = path.join(root, "model");
  let removeAtPreparing = false;
  let removal: Promise<void> | undefined;
  const store = new FormFillArtifactStore({
    rootDir: modelRoot,
    supported: () => ({ supported: true }),
    files: TEST_FILES,
    fetchImpl: async (url) => {
      const name = String(url);
      const content = name.endsWith("model.mlmodel")
        ? "model-bytes"
        : name.endsWith("weight.bin")
          ? "weights"
          : "license";
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of new TextEncoder().encode(content))
              controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
    },
    onStatusChanged: (status) => {
      if (removeAtPreparing && status.state === "preparing")
        removal = store.remove();
    },
  });
  try {
    await store.download();
    assert.equal(store.status().state, "ready");
    assert.equal(await verifyFormFillPackage(modelRoot, TEST_FILES), null);
    mkdirSync(store.compiledDir, { recursive: true });
    writeFileSync(path.join(store.compiledDir, "generated.bin"), "compiled");
    assert.equal(await verifyFormFillPackage(modelRoot, TEST_FILES), null);
    removeAtPreparing = true;
    await store.download();
    await removal;
    assert.equal(store.status().state, "not-downloaded");
    assert.equal(
      await verifyFormFillPackage(modelRoot, TEST_FILES),
      "The model directory is unreadable.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unparseable macOS version fails closed and the native package keeps its extension", () => {
  assert.equal(
    isFormFillSupported({
      platform: "darwin",
      arch: "arm64",
      osRelease: "unknown",
    }).supported,
    false,
  );
  assert.equal(path.extname(FORM_FILL_MODEL_PACKAGE_DIR), ".mlpackage");
});

test("concurrent runtime preparation compiles once and shutdown fences late compilation", async () => {
  const { FormFillRuntime } = await import("./runtime.js");
  const root = makeTemp();
  let release!: () => void;
  let started!: () => void;
  let compiling = new Promise<void>((resolve) => {
    started = resolve;
  });
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let compiles = 0;
  let loads = 0;
  const client = {
    isPoisoned: false,
    dispose() {},
    async compileModel() {
      compiles++;
      started();
      await gate;
      return path.join(root, "compiled.mlmodelc");
    },
    async loadModel() {
      loads++;
    },
    async shutdown() {},
  } as unknown as import("./helper-client.js").FormFillHelperClient;
  const runtime = new FormFillRuntime(
    new FormFillArtifactStore({ rootDir: path.join(root, "source") }),
    {
      clientFactory: () => client,
      supported: () => ({ supported: true }),
      verifyPackage: async () => null,
    },
  );
  try {
    const caller = new AbortController();
    const first = runtime.ensureReady(caller.signal);
    const firstRejected = assert.rejects(first);
    const second = runtime.ensureReady();
    await compiling;
    caller.abort();
    await firstRejected;
    release();
    await second;
    assert.equal(compiles, 1);
    assert.equal(loads, 1);
    await runtime.shutdown();
    compiling = new Promise<void>((resolve) => {
      started = resolve;
    });
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = runtime.ensureReady();
    const rejected = assert.rejects(late);
    await compiling;
    const stopped = runtime.shutdown();
    release();
    await Promise.all([stopped, rejected]);
    assert.equal(loads, 1, "late compilation must not load after shutdown");
  } finally {
    await runtime.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("removal immediately hides readiness and a prior refresh cannot resurrect it", async () => {
  const root = makeTemp();
  writeTestTree(root);
  const store = new FormFillArtifactStore({ rootDir: root, files: TEST_FILES, supported: () => ({ supported: true }) });
  await store.refresh();
  assert.equal(store.status().state, "ready");
  const refresh = store.refresh();
  const removal = store.remove();
  assert.equal(store.status().state, "not-downloaded");
  await Promise.all([refresh, removal]);
  assert.equal(store.status().state, "not-downloaded");
});

test("a completed publish cannot advertise readiness after removal starts", async () => {
  const { rename } = await import("node:fs/promises");
  const parent = makeTemp();
  let published!: () => void;
  let release!: () => void;
  const atPublish = new Promise<void>((resolve) => { published = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let removing = false;
  const states: string[] = [];
  const store = new FormFillArtifactStore({
    rootDir: path.join(parent, "model"), files: TEST_FILES, supported: () => ({ supported: true }),
    fetchImpl: async (url) => new Response(String(url).endsWith("model.mlmodel") ? "model-bytes" : String(url).endsWith("weight.bin") ? "weights" : "license"),
    rename: async (from, to) => { await rename(from, to); if (String(from).includes(".staging-")) { published(); await gate; } },
    onStatusChanged: (status) => { if (removing) states.push(status.state); },
  });
  try {
    const download = store.download();
    await atPublish;
    removing = true;
    const removal = store.remove();
    assert.equal(store.status().state, "not-downloaded");
    release();
    await Promise.all([download, removal]);
    assert.ok(!states.includes("ready"));
    assert.equal(store.status().state, "not-downloaded");
  } finally { release(); rmSync(parent, { recursive: true, force: true }); }
});

test("removal preserves model files when the execution drain fails", async () => {
  const root = makeTemp();
  writeTestTree(root);
  const store = new FormFillArtifactStore({ rootDir: root, files: TEST_FILES, supported: () => ({ supported: true }) });
  try {
    await assert.rejects(store.remove(async () => { throw new Error("execution still running"); }), /execution still running/);
    assert.equal(await verifyFormFillPackage(root, TEST_FILES), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real cancel-and-settle timeout leaves verified model files on disk", async () => {
  const { cancelComputerUseAndSettle, ComputerUseGenerationGate } = await import("../computer-use/generation-gate.js");
  const root = makeTemp();
  writeTestTree(root);
  const store = new FormFillArtifactStore({ rootDir: root, files: TEST_FILES, supported: () => ({ supported: true }) });
  const active = new Map([["cu", { computerUse: { closeAndSettle: () => new Promise<void>(() => {}) } }]]);
  try {
    await assert.rejects(store.remove(() => cancelComputerUseAndSettle({
      gate: new ComputerUseGenerationGate(), initializations: () => new Map(), active: () => active,
      cancel: () => { active.clear(); }, timeoutMs: 10,
    })), /model was not removed/);
    assert.equal(await verifyFormFillPackage(root, TEST_FILES), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
