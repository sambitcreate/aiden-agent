import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const publisher = new URL("./publish-github-release.sh", import.meta.url);

const fakeGhSource = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
const fail = (message) => { save(); process.stderr.write(message + "\n"); process.exit(1); };
const releaseJson = () => JSON.stringify({
  tagName: process.env.RELEASE_TAG,
  targetCommitish: state.target,
  isDraft: state.draft,
  assets: state.assets,
});

if (args[0] === "release" && args[1] === "view") {
  state.viewCalls += 1;
  if (state.transientLookups > 0) {
    state.transientLookups -= 1;
    fail("gh: service unavailable (HTTP 503)");
  }
  if (!state.exists) fail("release not found");
  save();
  process.stdout.write(releaseJson());
  process.exit(0);
}

if (args[0] === "release" && args[1] === "create") {
  state.createCalls += 1;
  state.exists = true;
  state.target = state.createTarget || process.env.GITHUB_SHA;
  state.draft = state.createDraft ?? true;
  state.assets = [{ name: "partial.asset", size: 1 }];
  fail("gh: service unavailable after create (HTTP 503)");
}

if (args[0] === "release" && args[1] === "upload") {
  state.uploadCalls += 1;
  const separator = args.indexOf("--");
  const files = args.slice(separator + 1);
  state.assets = files.map((file) => ({ name: path.basename(file), size: 1 }));
  save();
  process.exit(0);
}

if (args[0] === "release" && args[1] === "edit") {
  state.editCalls += 1;
  state.draft = false;
  if (state.edit503) {
    state.edit503 = false;
    fail("gh: service unavailable after publish (HTTP 503)");
  }
  save();
  process.exit(0);
}

fail("unexpected fake gh invocation: " + args.join(" "));
`;

async function fixture(initialState) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-release-publish-"));
  const bin = path.join(root, "bin");
  const distribution = path.join(root, "distribution");
  const runnerTemp = path.join(root, "runner");
  await Promise.all([mkdir(bin), mkdir(distribution), mkdir(runnerTemp)]);
  await Promise.all([
    writeFile(path.join(distribution, "Aiden-Agent-Beta-0.30.1-arm64.dmg"), "dmg"),
    writeFile(path.join(distribution, "Aiden-Agent-0.30.1-arm64-mac.zip"), "zip"),
    writeFile(path.join(distribution, "latest-mac.yml"), "version: 0.30.1\n"),
  ]);
  const ghPath = path.join(bin, "gh");
  const statePath = path.join(root, "state.json");
  await writeFile(ghPath, fakeGhSource, "utf8");
  await chmod(ghPath, 0o755);
  await writeFile(
    statePath,
    JSON.stringify({
      viewCalls: 0,
      createCalls: 0,
      uploadCalls: 0,
      editCalls: 0,
      transientLookups: 0,
      exists: false,
      draft: true,
      target: "",
      createTarget: "",
      createDraft: true,
      assets: [],
      edit503: false,
      ...initialState,
    }),
  );
  return {
    distribution,
    statePath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_GH_STATE: statePath,
      GH_TOKEN: "test-token",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SHA: "0123456789abcdef",
      RELEASE_TAG: "v0.30.1",
      RELEASE_VERSION: "0.30.1",
      RUNNER_TEMP: runnerTemp,
      AIDEN_RELEASE_RETRY_BASE_SECONDS: "0",
    },
  };
}

test("reconciles transient lookup, create, and publish failures without replacing another release", async () => {
  const setup = await fixture({ transientLookups: 1, edit503: true });
  await execFileAsync("bash", [publisher.pathname, setup.distribution], { env: setup.env });
  const state = JSON.parse(await readFile(setup.statePath, "utf8"));
  assert.equal(state.exists, true);
  assert.equal(state.draft, false);
  assert.equal(state.target, setup.env.GITHUB_SHA);
  assert.equal(state.createCalls, 1);
  assert.equal(state.uploadCalls, 1);
  assert.equal(state.editCalls, 1);
  assert.deepEqual(
    state.assets.map((asset) => asset.name).sort(),
    [
      "Aiden-Agent-0.30.1-arm64-mac.zip",
      "Aiden-Agent-Beta-0.30.1-arm64.dmg",
      "Aiden-Agent-Beta-arm64.dmg",
      "SHA256SUMS",
      "latest-mac.yml",
    ].sort(),
  );
});

test("fails closed before upload when the release tag already exists", async () => {
  const setup = await fixture({
    exists: true,
    draft: true,
    target: "another-sha",
    assets: [{ name: "foreign.asset", size: 1 }],
  });
  await assert.rejects(
    execFileAsync("bash", [publisher.pathname, setup.distribution], { env: setup.env }),
    /already exists/u,
  );
  const state = JSON.parse(await readFile(setup.statePath, "utf8"));
  assert.equal(state.createCalls, 0);
  assert.equal(state.uploadCalls, 0);
  assert.equal(state.editCalls, 0);
});

test("fails closed before creation when release lookup remains unavailable", async () => {
  const setup = await fixture({ transientLookups: 10 });
  await assert.rejects(
    execFileAsync("bash", [publisher.pathname, setup.distribution], {
      env: {
        ...setup.env,
        AIDEN_RELEASE_RETRY_ATTEMPTS: "3",
      },
    }),
    /release lookup did not settle after 3 attempts/iu,
  );
  const state = JSON.parse(await readFile(setup.statePath, "utf8"));
  assert.equal(state.viewCalls, 3);
  assert.equal(state.createCalls, 0);
  assert.equal(state.uploadCalls, 0);
  assert.equal(state.editCalls, 0);
});

test("fails closed when an ambiguous create resolves to a foreign release", async () => {
  const setup = await fixture({ createTarget: "foreign-sha" });
  await assert.rejects(
    execFileAsync("bash", [publisher.pathname, setup.distribution], { env: setup.env }),
    /collided with a release not owned by this workflow/iu,
  );
  const state = JSON.parse(await readFile(setup.statePath, "utf8"));
  assert.equal(state.createCalls, 1);
  assert.equal(state.uploadCalls, 0);
  assert.equal(state.editCalls, 0);
});
