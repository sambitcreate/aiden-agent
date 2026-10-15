import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const QUOTED_INCLUDE = /^\s*#\s*include\s+"([^"]+)"/gmu;

async function sourceClosure(source, seen = new Map()) {
  const resolved = path.resolve(source);
  if (seen.has(resolved)) return seen;
  const contents = await readFile(resolved);
  seen.set(resolved, contents);
  for (const [, include] of contents.toString("utf8").matchAll(QUOTED_INCLUDE)) {
    const header = path.resolve(path.dirname(resolved), include);
    try {
      await sourceClosure(header, seen);
    } catch (error) {
      // A quoted include the compiler finds on its search path is not ours.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return seen;
}

/**
 * Fingerprints everything that determines a helper binary: the source and the
 * local headers it includes (transitively), the compiler, its arguments and
 * environment, and the host platform and architecture.
 */
export async function nativeCBuildFingerprint({ source, executable, args, env, cwd }) {
  const hash = createHash("sha256");
  const add = (value) => hash.update(`${value.length}:`).update(value);
  add(JSON.stringify({ executable, args, env, platform: globalThis.process.platform, arch: globalThis.process.arch }));
  const closure = await sourceClosure(source);
  for (const file of [...closure.keys()].sort()) {
    add(path.relative(cwd, file));
    add(closure.get(file));
  }
  return hash.digest("hex");
}

/**
 * Runs a native C compile unless `<output>.stamp` records the same
 * fingerprint and the output still exists. Returns whether it compiled.
 */
export async function compileNativeC({ executeFile, executable, args, env, cwd, source, output }) {
  const stamp = `${output}.stamp`;
  const fingerprint = await nativeCBuildFingerprint({ source, executable, args, env, cwd });
  try {
    const [recorded] = await Promise.all([readFile(stamp, "utf8"), access(output, fsConstants.X_OK)]);
    if (recorded.trim() === fingerprint) return false;
  } catch {
    // No usable stamp or output: build.
  }
  await mkdir(path.dirname(output), { recursive: true });
  // Never let a stale stamp vouch for a half-written output.
  await rm(stamp, { force: true });
  await executeFile(executable, args, { cwd, env, maxBuffer: 1024 * 1024, timeout: 120_000 });
  await writeFile(stamp, `${fingerprint}\n`);
  return true;
}

const BUILD_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});

// xcrun must honor a caller-selected Xcode or SDK. Without them, hosts whose
// Command Line Tools SDK cannot link the helper have no way to build it.
const DARWIN_TOOLCHAIN_VARIABLES = Object.freeze(["DEVELOPER_DIR", "SDKROOT"]);

function darwinBuildEnvironment(environment) {
  const selected = {};
  for (const name of DARWIN_TOOLCHAIN_VARIABLES) {
    if (environment[name]) selected[name] = environment[name];
  }
  return Object.freeze({ ...BUILD_ENVIRONMENT, ...selected });
}

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed system compiler.
    }
  }
  throw new Error(
    `A C compiler is required to build Aiden's native helpers. Tried: ${candidates.join(", ")}`,
  );
}

export async function nativeCCompileInvocation({
  platform = globalThis.process.platform,
  source,
  output,
  testingDefine,
  testing = false,
  universalMac = !testing,
  environment = globalThis.process.env,
}) {
  const common = [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    ...(testing && testingDefine ? [`-D${testingDefine}=1`] : []),
  ];
  if (platform === "darwin") {
    return {
      executable: "/usr/bin/xcrun",
      args: [
        "--sdk",
        "macosx",
        "clang",
        ...common,
        "-mmacosx-version-min=14.4",
        ...(universalMac ? ["-arch", "arm64", "-arch", "x86_64"] : []),
        source,
        "-o",
        output,
      ],
      env: darwinBuildEnvironment(environment),
    };
  }
  if (platform === "linux") {
    const compiler = await firstExecutable([
      "/usr/bin/cc",
      "/usr/bin/clang",
      "/usr/bin/gcc",
    ]);
    return {
      executable: compiler,
      // Each helper owns its feature-test macros at the top of the translation
      // unit so they are defined before any system header. Injecting the same
      // macro here makes GCC's -Werror builds fail on Linux as a redefinition.
      args: [...common, source, "-o", output],
      env: BUILD_ENVIRONMENT,
    };
  }
  return null;
}

export async function buildNativeCExecutable({
  executeFile,
  repositoryRoot,
  source,
  output,
  testingDefine,
  testing = false,
  universalMac,
}) {
  const invocation = await nativeCCompileInvocation({
    source,
    output,
    testingDefine,
    testing,
    universalMac,
  });
  if (!invocation) return false;
  await compileNativeC({
    executeFile,
    executable: invocation.executable,
    args: invocation.args,
    env: invocation.env,
    cwd: repositoryRoot,
    source,
    output,
  });
  return true;
}
