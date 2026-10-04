import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { compileNativeC, nativeCCompileInvocation } from "./native-c-build-core.mjs";

test("native helper builds retain the universal macOS contract", async () => {
  const invocation = await nativeCCompileInvocation({
    platform: "darwin",
    source: "/repo/native/helper.c",
    output: "/repo/build/helper",
    testing: false,
  });
  assert.equal(invocation.executable, "/usr/bin/xcrun");
  assert.deepEqual(invocation.args.slice(0, 3), ["--sdk", "macosx", "clang"]);
  assert.deepEqual(
    invocation.args.filter((value) => value === "arm64" || value === "x86_64"),
    ["arm64", "x86_64"],
  );
  assert.ok(invocation.args.includes("-mmacosx-version-min=14.4"));
});

test("native macOS helper builds keep a fixed environment plus the selected Xcode and SDK", async () => {
  const invocation = await nativeCCompileInvocation({
    platform: "darwin",
    source: "/repo/native/helper.c",
    output: "/repo/build/helper",
    environment: {
      DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
      SDKROOT: "/sdk/MacOSX.sdk",
      HOME: "/Users/someone",
      PATH: "/opt/homebrew/bin:/usr/bin",
    },
  });
  assert.deepEqual(invocation.env, {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    LC_ALL: "C",
    DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer",
    SDKROOT: "/sdk/MacOSX.sdk",
  });
  const unselected = await nativeCCompileInvocation({
    platform: "darwin",
    source: "/repo/native/helper.c",
    output: "/repo/build/helper",
    environment: { HOME: "/Users/someone" },
  });
  assert.deepEqual(unselected.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" });
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

test("native helper compiles are skipped only while sources, local headers, flags, and output are unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-native-stamp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "native", "shared"), { recursive: true });
  const source = path.join(root, "native", "helper", "main.c");
  await mkdir(path.dirname(source));
  await writeFile(source, '#include <stdio.h>\n#include "../shared/platform.h"\nint main(void) { return 0; }\n');
  await writeFile(path.join(root, "native", "shared", "platform.h"), '#include "limits.h"\n#define AIDEN 1\n');
  await writeFile(path.join(root, "native", "shared", "limits.h"), "#define AIDEN_LIMIT 4\n");
  const output = path.join(root, "build", "native", "aiden-helper");

  let compiles = 0;
  let failNext = false;
  const executeFile = async (_executable, args) => {
    compiles += 1;
    const target = args[args.indexOf("-o") + 1];
    await writeFile(target, "partial");
    if (failNext) throw new Error("compiler failed");
    await chmod(target, 0o755);
  };
  const compile = (args = ["-O2", source, "-o", output]) => compileNativeC({
    executeFile, executable: "/usr/bin/cc", args, env: { LANG: "C" }, cwd: root, source, output,
  });

  assert.equal(await compile(), true, "first build compiles");
  assert.equal(await compile(), false, "an unchanged build is skipped");
  assert.equal(compiles, 1);

  await writeFile(path.join(root, "native", "shared", "limits.h"), "#define AIDEN_LIMIT 8\n");
  assert.equal(await compile(), true, "a transitively included header invalidates the build");
  assert.equal(await compile(["-O0", source, "-o", output]), true, "changed flags invalidate the build");
  await rm(output);
  assert.equal(await compile(["-O0", source, "-o", output]), true, "a missing output is rebuilt");

  failNext = true;
  await writeFile(source, "int main(void) { return 1; }\n");
  await assert.rejects(compile(), /compiler failed/u);
  failNext = false;
  assert.equal(await compile(), true, "a failed compile never leaves a stamp that skips the retry");
  assert.equal(compiles, 6);
});
