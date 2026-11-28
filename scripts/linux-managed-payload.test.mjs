import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const manifest = fileURLToPath(
  new URL("../native/linux-managed-payload/Cargo.toml", import.meta.url),
);
test(
  "managed payload native schema and unprivileged contracts",
  { skip: process.platform !== "linux", timeout: 180_000 },
  () => {
    // No sudo and no silent missing-toolchain success. Root acceptance is explicit.
    const deadline = Date.now() + 175_000;
    for (const args of [
      ["fmt", "--manifest-path", manifest, "--", "--check"],
      ["test", "--locked", "--manifest-path", manifest],
      ["clippy", "--locked", "--all-targets", "--manifest-path", manifest, "--", "-D", "warnings"],
    ]) {
      const result = spawnSync("cargo", args, {
        encoding: "utf8",
        timeout: Math.max(1_000, deadline - Date.now()),
      });
      assert.ifError(result.error);
      assert.equal(
        result.status,
        0,
        `cargo ${args.join(" ")}:\n${result.stdout}\n${result.stderr}`,
      );
    }
  },
);
