import { lstat, opendir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MAX_INITIAL_RENDERER_BYTES = 3 * 1024 * 1024;
const MAX_SINGLE_RENDERER_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_BUILD_SOURCE_MAP_BYTES = 14 * 1024 * 1024;
const MAX_UNPACKED_APP_BYTES = 700 * 1024 * 1024;

const MAX_WALK_FILES = 100_000;
const MAX_WALK_DEPTH = 64;

async function walk(root, state = { entries: 0 }, depth = 0) {
  if (depth > MAX_WALK_DEPTH) throw new Error("Performance budget input is nested too deeply.");
  const files = [];
  const directory = await opendir(root);
  for await (const entry of directory) {
    state.entries += 1;
    if (state.entries > MAX_WALK_FILES) {
      throw new Error("Performance budget input exceeds its entry-count limit.");
    }
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file, state, depth + 1)));
    else files.push(file);
  }
  return files;
}

export async function verifyPerformanceBudgets(buildRoot = "build") {
  const rendererRoot = path.join(buildRoot, "renderer");
  const files = await walk(rendererRoot);
  const javascript = files.filter((file) => file.endsWith(".js"));
  const sizes = [];
  for (const file of javascript) sizes.push({ file, bytes: (await stat(file)).size });
  const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
  const maximum = Math.max(0, ...sizes.map((entry) => entry.bytes));
  const allBuildFiles = await walk(buildRoot);
  const sourceMapFiles = allBuildFiles.filter((file) => file.endsWith(".map"));
  let sourceMapBytes = 0;
  for (const file of sourceMapFiles) sourceMapBytes += (await stat(file)).size;
  if (total > MAX_INITIAL_RENDERER_BYTES)
    throw new Error(
      `Renderer JavaScript ${total} exceeds the Phase 0 budget ${MAX_INITIAL_RENDERER_BYTES}.`,
    );
  if (maximum > MAX_SINGLE_RENDERER_CHUNK_BYTES)
    throw new Error(
      `Renderer chunk ${maximum} exceeds the Phase 0 budget ${MAX_SINGLE_RENDERER_CHUNK_BYTES}.`,
    );
  if (sourceMapBytes > MAX_BUILD_SOURCE_MAP_BYTES)
    throw new Error(
      `Build source maps use ${sourceMapBytes} bytes; the Phase 0 baseline budget is ${MAX_BUILD_SOURCE_MAP_BYTES}.`,
    );
  return { rendererJavaScriptBytes: total, largestRendererChunkBytes: maximum, sourceMapBytes };
}

export async function verifyPackagePerformanceBudget(appPath) {
  let bytes = 0;
  let files = 0;
  let entries = 0;
  const visit = async (root, depth = 0) => {
    if (depth > MAX_WALK_DEPTH) throw new Error("Package input is nested too deeply.");
    const directory = await opendir(root);
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_WALK_FILES) throw new Error("Package input has too many entries.");
      const candidate = path.join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(candidate);
        bytes += info.size;
        files += 1;
        if (bytes > MAX_UNPACKED_APP_BYTES) {
          throw new Error(
            `Unpacked application exceeds the Phase 0 package budget ${MAX_UNPACKED_APP_BYTES}.`,
          );
        }
      }
    }
  };
  await visit(appPath);
  return { packageBytes: bytes, packageFiles: files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const packageIndex = process.argv.indexOf("--package");
  const operation =
    packageIndex >= 0
      ? verifyPackagePerformanceBudget(process.argv[packageIndex + 1])
      : verifyPerformanceBudgets(process.argv[2] ?? "build");
  operation
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
