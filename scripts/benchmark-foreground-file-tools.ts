/** Run with tsx; optional module path permits the exact baseline source with this lockfile. */
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2] ?? "main/services/coding-tools.ts";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-foreground-benchmark-"));
const originalReadFile = fs.readFile;
const originalOpen = fs.open;
const originalReaddir = fs.readdir;
const originalOpendir = fs.opendir;
let enumeratedEntries = 0;
let bytesRead = 0;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  const value = await originalReadFile(...args);
  bytesRead += Buffer.byteLength(value);
  return value;
}) as typeof fs.readFile;
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  const read = handle.read.bind(handle);
  handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
    const result = await read(...readArgs);
    bytesRead += result.bytesRead;
    return result;
  }) as typeof handle.read;
  return handle;
}) as typeof fs.open;
fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
  const entries = await originalReaddir(...args);
  enumeratedEntries += entries.length;
  return entries;
}) as typeof fs.readdir;
fs.opendir = (async (...args: Parameters<typeof fs.opendir>) => {
  const directory = await originalOpendir(...args);
  const read = directory.read.bind(directory);
  directory.read = (async () => {
    const entry = await read();
    if (entry) enumeratedEntries++;
    return entry;
  }) as typeof directory.read;
  return directory;
}) as typeof fs.opendir;
syncBuiltinESMExports();
try {
  const { buildCodingTools } = await import(pathToFileURL(path.resolve(modulePath)).href);
  const full = path.join(root, "large.txt");
  await fs.writeFile(full, Buffer.alloc(16 * 1024 * 1024, 97));
  const tools = buildCodingTools(root);
  const invoke = async (name: string, params: object, signal?: AbortSignal) => {
    const result = await tools
      .find((tool: { name: string }) => tool.name === name)
      .execute("benchmark", params, signal);
    return result.content[0].text as string;
  };
  bytesRead = 0;
  const readText = await invoke("read_file", { path: "large.txt" });
  const read = { inputBytes: 16 * 1024 * 1024, bytesRead, outputChars: readText.length };
  await fs.rm(full);
  await fs.writeFile(path.join(root, "tiny.txt"), "needle\n");
  const controller = new AbortController();
  controller.abort(new Error("benchmark cancelled"));
  let rejected = false;
  bytesRead = 0;
  try {
    await invoke("grep", { pattern: "needle" }, controller.signal);
  } catch {
    rejected = true;
  }
  const abortedGrep = { rejected, bytesRead };
  const timings: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    if ((await invoke("grep", { pattern: "needle" })) !== "tiny.txt:1: needle")
      throw new Error("Incorrect normal result");
    timings.push(performance.now() - start);
  }
  await fs.rm(path.join(root, "tiny.txt"));
  for (let offset = 0; offset < 10_100; offset += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        fs.writeFile(path.join(root, `file-${offset + index}.txt`), ""),
      ),
    );
  }
  const scans = [];
  for (const [name, params] of [
    ["list_dir", {}],
    ["glob", { pattern: "**/*.absent" }],
    ["grep", { pattern: "absent" }],
  ] as const) {
    enumeratedEntries = 0;
    const text = await invoke(name, params);
    scans.push({
      name,
      enumeratedEntries,
      outputChars: text.length,
      incompleteNotice: text.includes("scan stopped"),
    });
  }
  console.log(
    JSON.stringify(
      {
        modulePath,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        piVersion: JSON.parse(
          await originalReadFile(
            new URL("../node_modules/@earendil-works/pi-ai/package.json", import.meta.url),
            "utf8",
          ),
        ).version,
        read,
        abortedGrep,
        smallGrepMs: timings,
        wideFixtureEntries: 10_100,
        scans,
      },
      null,
      2,
    ),
  );
} finally {
  fs.readFile = originalReadFile;
  fs.open = originalOpen;
  fs.readdir = originalReaddir;
  fs.opendir = originalOpendir;
  syncBuiltinESMExports();
  await fs.rm(root, { recursive: true, force: true });
}
