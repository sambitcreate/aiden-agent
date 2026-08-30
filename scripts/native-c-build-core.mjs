import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const BUILD_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
});

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
        "clang",
        ...common,
        "-mmacosx-version-min=14.4",
        ...(universalMac ? ["-arch", "arm64", "-arch", "x86_64"] : []),
        source,
        "-o",
        output,
      ],
      env: BUILD_ENVIRONMENT,
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
  await mkdir(path.dirname(output), { recursive: true });
  await executeFile(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    env: invocation.env,
    maxBuffer: 1024 * 1024,
    timeout: 120_000,
  });
  return true;
}
