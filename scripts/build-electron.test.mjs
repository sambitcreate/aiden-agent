import process from "node:process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parse as parseAcorn } from "acorn";
import { build } from "esbuild";
import { cleanMainBuildOutput, electronBuildOptions } from "./build-electron.mjs";

const ENTRY_FIXTURE = `export class SessionLedger {
  record(entry: string) {
    return entry;
  }
}

export function describeFailure() {
  const ledger = new SessionLedger();
  ledger.record("unused");
  throw new Error("fixture failure");
}

export const serializedProbe = function readWindowSize() {
  return { width: innerWidth, height: innerHeight };
};

export function loadLazySubsystem() {
  return import("./lazy-subsystem.ts");
}
`;

const LAZY_SUBSYSTEM_FIXTURE = `export class LazySubsystem {
  describe(label: string) {
    return \`lazy:\${label}\`;
  }
}

export function describeLazyFailure() {
  const subsystem = new LazySubsystem();
  subsystem.describe("unused");
  throw new Error("lazy subsystem failure");
}
`;

function findMainBundleOptions(options) {
  return options.find(
    (candidate) =>
      candidate.outdir === "build/main" &&
      candidate.splitting === true &&
      candidate.entryNames === "index",
  );
}

function parseModuleAst(code) {
  const comments = [];
  const ast = parseAcorn(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    onComment: comments,
  });
  return { ast, comments };
}

function hasSourceMappingUrlComment(code) {
  const { comments } = parseModuleAst(code);
  return comments.some((comment) => /^[#@]\s*sourceMappingURL=/u.test(comment.value));
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkAst(value, visit);
  }
}

function collectModuleImports(code) {
  const { ast } = parseModuleAst(code);
  const statics = [];
  const dynamics = [];
  walkAst(ast, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source &&
      typeof node.source.value === "string"
    ) {
      statics.push(node.source.value);
    } else if (
      node.type === "ImportExpression" &&
      node.source?.type === "Literal" &&
      typeof node.source.value === "string"
    ) {
      dynamics.push(node.source.value);
    }
  });
  return { statics, dynamics };
}

async function buildSplitFixture(options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-build-electron-"));
  const entry = path.join(directory, "entry.ts");
  const lazyFile = path.join(directory, "lazy-subsystem.ts");
  const outdir = path.join(directory, "out");
  await Promise.all([
    writeFile(entry, ENTRY_FIXTURE),
    writeFile(lazyFile, LAZY_SUBSYSTEM_FIXTURE),
    writeFile(path.join(directory, "package.json"), '{"type":"module"}\n'),
  ]);
  // Reuse the real main-process option set and swap only the entry/outdir.
  const main = findMainBundleOptions(options);
  assert.ok(main, "split main-process bundle options exist");
  await build({ ...main, entryPoints: [entry], outdir, logLevel: "silent" });
  const files = (await readdir(outdir)).sort();
  const chunks = files.filter((name) => /^chunk-[A-Za-z0-9_-]+\.js$/u.test(name));
  return {
    directory,
    entry,
    lazyFile,
    outdir,
    indexFile: path.join(outdir, "index.js"),
    files,
    chunks,
  };
}

test("production split main bundle keeps names and symbolicates entry and lazy chunks through unreferenced external maps", async (t) => {
  const development = await buildSplitFixture(electronBuildOptions());
  const production = await buildSplitFixture(electronBuildOptions({ production: true }));
  t.after(() =>
    Promise.all(
      [development, production].map(({ directory }) =>
        rm(directory, { recursive: true, force: true }),
      ),
    ),
  );

  assert.ok(development.chunks.length >= 1, "development build emits split chunks");
  assert.ok(production.chunks.length >= 1, "production build emits split chunks");
  for (const jsFile of ["index.js", ...production.chunks]) {
    assert.ok(
      production.files.includes(`${jsFile}.map`),
      `expected external map for ${jsFile}`,
    );
  }

  const developmentCode = await readFile(development.indexFile, "utf8");
  const productionCode = await readFile(production.indexFile, "utf8");
  assert.ok(productionCode.length < developmentCode.length, "production output is minified");
  assert.equal(
    hasSourceMappingUrlComment(developmentCode),
    true,
    "development entry keeps linked source map comment",
  );
  for (const chunkName of development.chunks) {
    const chunkCode = await readFile(path.join(development.outdir, chunkName), "utf8");
    assert.equal(
      hasSourceMappingUrlComment(chunkCode),
      true,
      `development chunk ${chunkName} keeps linked source map comment`,
    );
  }
  for (const jsFile of ["index.js", ...production.chunks]) {
    const code = await readFile(path.join(production.outdir, jsFile), "utf8");
    assert.equal(
      hasSourceMappingUrlComment(code),
      false,
      `production output ${jsFile} must never point at a map`,
    );
  }

  const loaded = await import(pathToFileURL(production.indexFile).href);
  assert.equal(loaded.SessionLedger.name, "SessionLedger");
  assert.equal(loaded.describeFailure.name, "describeFailure");
  // Functions serialized into another context must stay self-contained.
  assert.deepEqual(
    new Function("innerWidth", "innerHeight", `return (${loaded.serializedProbe})()`)(3, 4),
    { width: 3, height: 4 },
  );

  let entryStack = "";
  try {
    loaded.describeFailure();
  } catch (error) {
    entryStack = error.stack;
  }
  const entryFrame = entryStack.match(/index\.js:(\d+):(\d+)/u);
  assert.ok(entryFrame, `stack names the bundled entry file: ${entryStack}`);
  assert.match(entryStack, /at (?:Module\.)?describeFailure /u, "stack frames keep function names");

  const entryMap = new SourceMap(
    JSON.parse(await readFile(`${production.indexFile}.map`, "utf8")),
  );
  const entryOriginal = entryMap.findEntry(
    Number(entryFrame[1]) - 1,
    Number(entryFrame[2]) - 1,
  );
  assert.equal(path.basename(entryOriginal.originalSource), "entry.ts");
  assert.match(
    ENTRY_FIXTURE.split("\n")[entryOriginal.originalLine],
    /throw new Error\("fixture failure"\)/u,
  );

  const lazyLoaded = await loaded.loadLazySubsystem();
  assert.equal(lazyLoaded.LazySubsystem.name, "LazySubsystem");
  assert.equal(lazyLoaded.describeLazyFailure.name, "describeLazyFailure");

  let lazyStack = "";
  try {
    lazyLoaded.describeLazyFailure();
  } catch (error) {
    lazyStack = error.stack;
  }
  const lazyFrame = lazyStack.match(/(chunk-[A-Za-z0-9_-]+\.js):(\d+):(\d+)/u);
  assert.ok(lazyFrame, `stack names the split chunk file: ${lazyStack}`);
  assert.match(
    lazyStack,
    /at (?:Module\.)?describeLazyFailure /u,
    "lazy chunk stack frames keep function names",
  );

  const lazyMap = new SourceMap(
    JSON.parse(await readFile(path.join(production.outdir, `${lazyFrame[1]}.map`), "utf8")),
  );
  const lazyOriginal = lazyMap.findEntry(Number(lazyFrame[2]) - 1, Number(lazyFrame[3]) - 1);
  assert.equal(path.basename(lazyOriginal.originalSource), "lazy-subsystem.ts");
  assert.match(
    LAZY_SUBSYSTEM_FIXTURE.split("\n")[lazyOriginal.originalLine],
    /throw new Error\("lazy subsystem failure"\)/u,
  );
});

test("cleanMainBuildOutput removes stale chunks and maps before rebuilding", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-clean-main-outdir-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outdir = path.join(directory, "main");
  await mkdir(outdir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outdir, "index.js"), "old-entry"),
    writeFile(path.join(outdir, "index.js.map"), "{}"),
    writeFile(path.join(outdir, "chunk-OBSOLETE.js"), "stale-chunk"),
    writeFile(path.join(outdir, "chunk-OBSOLETE.js.map"), "{}"),
    writeFile(path.join(outdir, "keep.txt"), "sentinel"),
  ]);

  cleanMainBuildOutput(outdir);
  assert.deepEqual(await readdir(outdir), ["keep.txt"]);
});

test("worker and preload bundles remain standalone outfiles while main startup graph defers heavy SDKs and OpenAPI schema", async (t) => {
  const options = electronBuildOptions({ production: true });
  const standaloneOutfiles = options
    .filter((candidate) => candidate.outdir !== "build/main")
    .map((candidate) => ({
      outfile: candidate.outfile,
      splitting: Boolean(candidate.splitting),
    }));
  assert.deepEqual(standaloneOutfiles, [
    { outfile: "build/main/pi-vcc-worker.js", splitting: false },
    { outfile: "build/main/subagent-inference-worker.js", splitting: false },
    { outfile: "build/main/subagent-inference-worker-runtime.js", splitting: false },
    { outfile: "build/main/local-speech-worker.js", splitting: false },
    { outfile: "build/preload/preload.cjs", splitting: false },
    { outfile: "build/preload/preload-pill.cjs", splitting: false },
    { outfile: "build/preload/preload-quick-chat.cjs", splitting: false },
    { outfile: "build/preload/preload-bot-bubbles.cjs", splitting: false },
  ]);

  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-main-startup-graph-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const main = findMainBundleOptions(options);
  await build({
    ...main,
    absWorkingDir: root,
    entryPoints: [path.join(root, "main/bootstrap.ts")],
    outdir: directory,
    logLevel: "silent",
  });

  const files = await readdir(directory);
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  const chunkFiles = jsFiles.filter((name) => /^chunk-[A-Za-z0-9_-]+\.js$/u.test(name));
  assert.ok(jsFiles.includes("index.js"), "emits index.js entry");
  assert.ok(chunkFiles.length > 10, "emits split ESM chunks");

  const codeByFile = new Map(
    await Promise.all(
      jsFiles.map(async (name) => [name, await readFile(path.join(directory, name), "utf8")]),
    ),
  );
  for (const [name, code] of codeByFile) {
    assert.ok(files.includes(`${name}.map`), `missing external map for ${name}`);
    assert.equal(
      hasSourceMappingUrlComment(code),
      false,
      `production chunk ${name} must not carry a sourceMappingURL comment`,
    );
  }

  // Walk index.js plus the bootstrap dynamic imports (including main/index.ts)
  // and every static chunk reachable from them before window creation.
  const entryImports = collectModuleImports(codeByFile.get("index.js"));
  const startupChunks = new Set();
  const startupExternals = new Set();
  const visitStaticGraph = (file) => {
    if (startupChunks.has(file)) return;
    startupChunks.add(file);
    const code = codeByFile.get(file);
    assert.ok(code !== undefined, `missing referenced startup chunk ${file}`);
    const { statics } = collectModuleImports(code);
    for (const specifier of statics) {
      if (specifier.startsWith("./")) {
        visitStaticGraph(specifier.slice(2));
      } else {
        startupExternals.add(specifier);
      }
    }
  };
  visitStaticGraph("index.js");
  for (const specifier of entryImports.dynamics) {
    if (specifier.startsWith("./")) visitStaticGraph(specifier.slice(2));
  }

  for (const forbiddenStartupExternal of [
    "typebox",
    "@agentclientprotocol/sdk",
    "@earendil-works/pi-ai/providers/all",
    "@modelcontextprotocol/sdk",
    "@google/genai",
  ]) {
    assert.equal(
      [...startupExternals].some(
        (specifier) =>
          specifier === forbiddenStartupExternal ||
          specifier.startsWith(`${forbiddenStartupExternal}/`),
      ),
      false,
      `expected ${forbiddenStartupExternal} to be deferred out of startup chunks, saw: ${[...startupExternals].join(", ")}`,
    );
  }

  const openapiChunks = [...codeByFile.entries()]
    .filter(([, code]) => code.includes("x-aiden-json-response-emission"))
    .map(([name]) => name);
  assert.equal(
    openapiChunks.length,
    1,
    `expected protocol/aiden-remote/v1/openapi.json in a single on-demand chunk, found: ${openapiChunks.join(", ")}`,
  );
  assert.notEqual(openapiChunks[0], "index.js");
  assert.equal(
    startupChunks.has(openapiChunks[0]),
    false,
    `expected OpenAPI chunk ${openapiChunks[0]} to stay out of the pre-window startup graph`,
  );
});

test(
  "the production Linux bundle reads artifact files without a macOS helper",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-linux-artifact-bundle-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const outdir = path.join(directory, "out");
    const main = findMainBundleOptions(electronBuildOptions({ production: true }));
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    await build({
      ...main,
      entryPoints: [path.join(root, "main/services/workspace-artifacts/file-policy.ts")],
      entryNames: "artifact-reader",
      outdir,
      logLevel: "silent",
    });
    const bundled = await import(pathToFileURL(path.join(outdir, "artifact-reader.js")).href);
    await writeFile(path.join(directory, "data.txt"), "bundled Linux workspace data");
    assert.equal(
      await bundled.readWorkspaceArtifactFile(directory, "data.txt"),
      "bundled Linux workspace data",
    );
  },
);
