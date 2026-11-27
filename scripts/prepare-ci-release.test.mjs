/* global process, URL */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  mainPushReleaseSelection,
  writeReleaseSelectionGithubOutput,
} from "./prepare-ci-release.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./prepare-ci-release.mjs", import.meta.url));
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

test("an unpublished declared version is selected exactly", () => {
  assert.deepEqual(mainPushReleaseSelection("0.35.0", false), {
    version: "0.35.0",
    tag: "v0.35.0",
    publish: true,
  });
});

test("an existing declared tag makes release publication a green no-op", () => {
  assert.deepEqual(mainPushReleaseSelection("0.35.0", true), {
    version: "0.35.0",
    tag: "v0.35.0",
    publish: false,
  });
});

test("declared release selection rejects ambiguous inputs", () => {
  assert.throws(
    () => mainPushReleaseSelection("1.0", false),
    /Invalid declared release version/u,
  );
  assert.throws(
    () => mainPushReleaseSelection("1.0.0", undefined),
    /Declared tag existence must be a boolean/u,
  );
});

test("--github-output fails when GITHUB_OUTPUT is unset and writes expected outputs when set", async (t) => {
  const { version } = JSON.parse(await readFile(packageJsonPath, "utf8"));
  await assert.rejects(
    writeReleaseSelectionGithubOutput(mainPushReleaseSelection(version, false), ""),
    /GITHUB_OUTPUT must be set/u,
  );

  const envWithoutOutput = { ...process.env };
  delete envWithoutOutput.GITHUB_OUTPUT;
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath, "false", "--github-output"], {
      env: envWithoutOutput,
    }),
    /GITHUB_OUTPUT must be set/u,
  );

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiden-prepare-ci-release-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const outputPath = path.join(tempDir, "github-output.txt");

  const { stdout } = await execFileAsync(
    process.execPath,
    [scriptPath, "true", "--github-output", "--announce-existing"],
    { env: { ...process.env, GITHUB_OUTPUT: outputPath } },
  );
  assert.equal(
    stdout.trim(),
    `v${version} already exists; skipping release without changing its version.`,
  );
  assert.equal(
    await readFile(outputPath, "utf8"),
    `version=${version}\ntag=v${version}\npublish=false\n`,
  );
});
