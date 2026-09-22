/* global URL */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json")));
const notices = await fs.readFile(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");

async function installedPackageDirectory(name, fromDirectory) {
  const segments = name.startsWith("@") ? name.split("/").slice(0, 2) : [name];
  let current = fromDirectory;
  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`Could not resolve installed package ${name}.`);
      current = parent;
    }
  }
}

async function runtimeClosure(rootName) {
  const found = new Map();
  const visit = async (name, fromDirectory) => {
    const directory = await installedPackageDirectory(name, fromDirectory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    if (manifest.name.startsWith("@types/")) return;
    const identity = `${manifest.name}@${manifest.version}`;
    if (found.has(identity)) return;
    found.set(identity, manifest.license);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await visit(dependency, directory);
    }
  };
  await visit(rootName, repositoryRoot);
  return [...found].sort(([left], [right]) => left.localeCompare(right));
}

test("Create Images pins React Flow and packages its complete runtime-closure notices", async () => {
  assert.equal(packageManifest.dependencies["@xyflow/react"], "12.9.3");
  assert.ok(packageManifest.build.files.includes("THIRD_PARTY_NOTICES.md"));
  for (const exclusion of [
    "!node_modules/@xyflow/**/*",
    "!node_modules/@types/d3-*/*",
    "!node_modules/classcat/**/*",
    "!node_modules/d3-*/*",
    "!node_modules/zustand/**/*",
  ]) {
    assert.ok(
      packageManifest.build.files.includes(exclusion),
      `Missing renderer-only package exclusion ${exclusion}`,
    );
  }
  const closure = await runtimeClosure("@xyflow/react");
  assert.deepEqual(
    closure,
    [
      ["@xyflow/react@12.9.3", "MIT"],
      ["@xyflow/system@0.0.73", "MIT"],
      ["classcat@5.0.5", "MIT"],
      ["d3-color@3.1.0", "ISC"],
      ["d3-dispatch@3.0.1", "ISC"],
      ["d3-drag@3.0.0", "ISC"],
      ["d3-ease@3.0.1", "BSD-3-Clause"],
      ["d3-interpolate@3.0.1", "ISC"],
      ["d3-selection@3.0.0", "ISC"],
      ["d3-timer@3.0.1", "ISC"],
      ["d3-transition@3.0.1", "ISC"],
      ["d3-zoom@3.0.0", "ISC"],
      ["use-sync-external-store@1.6.0", "MIT"],
      ["zustand@4.5.7", "MIT"],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  for (const [identity] of closure) {
    assert.ok(notices.includes(`\`${identity}\``), `Missing notice inventory for ${identity}`);
  }
  for (const heading of [
    "@xyflow/react and @xyflow/system",
    "classcat",
    "zustand",
    "use-sync-external-store",
    "D3 ISC packages",
    "d3-color",
    "d3-ease",
  ]) {
    assert.match(notices, new RegExp(`^## ${heading}$`, "mu"));
  }
  assert.match(notices, /Copyright \(c\) 2019-2025 webkid GmbH/u);
  assert.match(notices, /Copyright © Jorge Bucaran/u);
  assert.match(notices, /Copyright \(c\) 2019 Paul Henschel/u);
  assert.match(notices, /Copyright \(c\) Meta Platforms, Inc\. and affiliates\./u);
  assert.match(notices, /Copyright 2010-2022 Mike Bostock/u);
  assert.match(notices, /Copyright 2001 Robert Penner/u);
});

test("Create Images pins the native ZIP runtime and packages its complete notices", async () => {
  assert.equal(packageManifest.dependencies.yauzl, "3.4.0");
  assert.equal(packageManifest.dependencies.yazl, "3.3.1");
  const closure = new Map([
    ...(await runtimeClosure("yauzl")),
    ...(await runtimeClosure("yazl")),
  ]);
  assert.deepEqual(
    [...closure].sort(([left], [right]) => left.localeCompare(right)),
    [
      ["buffer-crc32@1.0.0", "MIT"],
      ["pend@1.2.0", "MIT"],
      ["yauzl@3.4.0", "MIT"],
      ["yazl@3.3.1", "MIT"],
    ],
  );
  for (const [identity] of closure) {
    assert.ok(notices.includes(`\`${identity}\``), `Missing notice inventory for ${identity}`);
  }
  assert.match(notices, /^## yauzl and yazl$/mu);
  assert.match(notices, /Copyright \(c\) 2014 Josh Wolfe/u);
  assert.match(notices, /Copyright \(c\) 2014 Andrew Kelley/u);
  assert.match(notices, /Copyright \(c\) 2013-2024 Brian J\. Brennan/u);
});
