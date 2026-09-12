import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import { nativeCCompileInvocation } from "./native-c-build-core.mjs";

test("native helper builds retain the universal macOS contract", async () => {
  const invocation = await nativeCCompileInvocation({
    platform: "darwin",
    source: "/repo/native/helper.c",
    output: "/repo/build/helper",
    testing: false,
  });
  assert.equal(invocation.executable, "/usr/bin/xcrun");
  assert.deepEqual(
    invocation.args.filter((value) => value === "arm64" || value === "x86_64"),
    ["arm64", "x86_64"],
  );
  assert.ok(invocation.args.includes("-mmacosx-version-min=14.4"));
});

test("native helper Linux builds use a host compiler without redefining source feature macros", async (context) => {
  if (globalThis.process.platform !== "linux") {
    context.skip("Linux compiler discovery is verified in Linux CI.");
    return;
  }
  const invocation = await nativeCCompileInvocation({
    platform: "linux",
    source: "/repo/native/helper.c",
    output: "/repo/build/helper",
    testingDefine: "AIDEN_TESTING",
    testing: true,
  });
  assert.match(invocation.executable, /\/(?:cc|clang|gcc)$/u);
  assert.equal(invocation.args.includes("-D_GNU_SOURCE"), false);
  assert.ok(invocation.args.includes("-DAIDEN_TESTING=1"));
  assert.equal(invocation.args.includes("-mmacosx-version-min=14.4"), false);
});

test("unsupported hosts do not produce misleading native helpers", async () => {
  assert.equal(
    await nativeCCompileInvocation({
      platform: "win32",
      source: "/repo/native/helper.c",
      output: "/repo/build/helper",
    }),
    null,
  );
});

test("subagent shell cleanup never enters an unbounded reap", async () => {
  const source = await readFile(
    new URL("../native/subagent-shell-runner/main.c", import.meta.url),
    "utf8",
  );
  const cleanup = source.slice(
    source.indexOf("static bool cleanup_group"),
    source.indexOf("static int run_shell"),
  );
  assert.match(cleanup, /deadline = monotonic_ms\(\) \+ 1000U;/u);
  assert.doesNotMatch(cleanup, /waitpid\([^;]*,\s*0\)/u);
  assert.equal((cleanup.match(/waitpid\([^;]*WNOHANG\)/gu) ?? []).length, 2);
});
