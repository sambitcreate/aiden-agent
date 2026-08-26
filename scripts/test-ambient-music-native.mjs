import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* global process */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = path.join(projectRoot, "build", "Aiden Ambient Music Native Tests");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  process.stdout.write("Ambient Music native tests skipped: requires Apple Silicon macOS.\n");
  process.exit(0);
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...extra,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("cmake", [
  "-S", path.join(projectRoot, "native", "ambient-music"),
  "-B", buildDirectory,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DAIDEN_AMBIENT_MUSIC_WITH_MAGENTA=OFF",
]);
run("cmake", ["--build", buildDirectory, "--parallel"]);
run("ctest", ["--test-dir", buildDirectory, "--output-on-failure"]);
run(process.execPath, ["--test", path.join(projectRoot, "scripts", "ambient-music-helper.test.mjs")], {
  env: {
    ...process.env,
    AIDEN_AMBIENT_MUSIC_TEST_HELPER: path.join(buildDirectory, "aiden-ambient-music-helper"),
  },
});
