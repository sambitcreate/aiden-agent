import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const manifest = fileURLToPath(new URL("../native/linux-managed-payload/Cargo.toml", import.meta.url));
test("managed payload native schema and unprivileged contracts", { skip: process.platform !== "linux", timeout: 180_000 }, () => {
  // No sudo and no silent missing-toolchain success. Root acceptance is explicit.
  const result = spawnSync("cargo", ["test", "--locked", "--manifest-path", manifest], { encoding: "utf8", timeout: 175_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
