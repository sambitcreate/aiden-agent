import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { SourceMap } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { electronBuildOptions } from "./build-electron.mjs";

const FIXTURE = `export class SessionLedger {
  record(entry) {
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
`;

async function buildFixture(options) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-build-electron-"));
  const entry = path.join(directory, "entry.ts");
  const outfile = path.join(directory, "out", "entry.mjs");
  await writeFile(entry, FIXTURE);
  // Reuse the real main-process option set and swap only the entry/output.
  const main = options.find((candidate) => candidate.outfile === "build/main/index.js");
  assert.ok(main, "main-process bundle options exist");
  await build({ ...main, entryPoints: [entry], outfile, logLevel: "silent" });
  return { directory, entry, outfile };
}

test("production main bundle is smaller but keeps names and symbolicates through an unreferenced external map", async (t) => {
  const development = await buildFixture(electronBuildOptions());
  const production = await buildFixture(electronBuildOptions({ production: true }));
  t.after(() => Promise.all([development, production].map(({ directory }) => rm(directory, { recursive: true, force: true }))));

  const developmentCode = await readFile(development.outfile, "utf8");
  const productionCode = await readFile(production.outfile, "utf8");
  assert.ok(productionCode.length < developmentCode.length, "production output is minified");
  assert.match(developmentCode, /sourceMappingURL=entry\.mjs\.map/u, "development keeps linked maps for debugging");
  assert.doesNotMatch(productionCode, /sourceMappingURL/u, "production bundles never point at a map");

  const loaded = await import(pathToFileURL(production.outfile).href);
  assert.equal(loaded.SessionLedger.name, "SessionLedger");
  assert.equal(loaded.describeFailure.name, "describeFailure");
  // Functions serialized into another context must stay self-contained.
  assert.deepEqual(new Function("innerWidth", "innerHeight", `return (${loaded.serializedProbe})()`)(3, 4), { width: 3, height: 4 });

  let stack = "";
  try {
    loaded.describeFailure();
  } catch (error) {
    stack = error.stack;
  }
  const frame = stack.match(/entry\.mjs:(\d+):(\d+)/u);
  assert.ok(frame, `stack names the bundled file: ${stack}`);
  assert.match(stack, /at (?:Module\.)?describeFailure /u, "stack frames keep function names");

  const map = new SourceMap(JSON.parse(await readFile(`${production.outfile}.map`, "utf8")));
  const original = map.findEntry(Number(frame[1]) - 1, Number(frame[2]) - 1);
  assert.equal(path.basename(original.originalSource), "entry.ts");
  const sourceLine = FIXTURE.split("\n")[original.originalLine];
  assert.match(sourceLine, /throw new Error\("fixture failure"\)/u);
});
