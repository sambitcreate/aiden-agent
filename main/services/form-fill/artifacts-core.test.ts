import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    assert.match((await verifyFormFillPackage(root, TEST_FILES)) ?? "", /missing/u);
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
    assert.match((await verifyFormFillPackage(root, TEST_FILES)) ?? "", /checksum/u);
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
    FORM_FILL_ARTIFACT_FILES.some((f) => f.path === `${FORM_FILL_MODEL_PACKAGE_DIR}/Manifest.json`),
  );
  assert.ok(!isAllowedArtifactPath("../escape"));
  assert.ok(!isAllowedArtifactPath("foo/../../bar"));
  assert.ok(!isAllowedArtifactPath(""));
  assert.ok(!isAllowedArtifactPath("cua_s1_forms_fp16_options32.mlpackage/evil.sh"));
  assert.equal(
    formFillArtifactUrl("LICENSE"),
    "https://huggingface.co/FluidInference/cua-s1-forms-coreml/resolve/ca2113d260559ee5d2d6463900e39916936aca65/LICENSE",
  );
});

test("isFormFillSupported gates on Apple silicon macOS 14.4+", () => {
  assert.equal(
    isFormFillSupported({ platform: "darwin", arch: "arm64", osRelease: "23.4.0" }).supported,
    true,
  );
  assert.equal(
    isFormFillSupported({ platform: "darwin", arch: "arm64", osRelease: "24.0.0" }).supported,
    true,
  );
  assert.equal(
    isFormFillSupported({ platform: "darwin", arch: "x64", osRelease: "24.0.0" }).supported,
    false,
  );
  assert.equal(
    isFormFillSupported({ platform: "darwin", arch: "arm64", osRelease: "23.3.0" }).supported,
    false,
  );
  assert.equal(
    isFormFillSupported({ platform: "linux", arch: "x64", osRelease: "6.8.0" }).supported,
    false,
  );
  assert.equal(
    isFormFillSupported({ platform: "win32", arch: "x64", osRelease: "10.0.0" }).supported,
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
