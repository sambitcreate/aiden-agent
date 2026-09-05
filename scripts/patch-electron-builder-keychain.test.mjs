import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import {
  patchKeychainSource,
  patchElectronBuilderKeychain,
} from "./patch-electron-builder-keychain.mjs";

const require = createRequire(import.meta.url);
const signingModule = require.resolve("app-builder-lib/out/codeSign/macCodeSign.js");

async function upstreamSource() {
  return (await readFile(signingModule, "utf8"))
    .replace(
      "importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)",
      "importCerts(keychainFile, certPaths, cscPasswords)",
    )
    .replace(
      "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword)",
      "async function importCerts(keychainFile, paths, keyPasswords)",
    )
    .replace('"-s", "-k", keychainPassword, keychainFile', '"-s", "-k", password, keychainFile');
}

async function signingCommands(source) {
  const commands = [];
  const module = { exports: {} };
  const signingRequire = createRequire(signingModule);
  const mockedRequire = (id) => {
    if (id === "builder-util")
      return {
        exec: async (command, args) => {
          assert.equal(command, "/usr/bin/security");
          commands.push(args);
          return "";
        },
      };
    if (id === "./codesign") return { importCertificate: async (link) => link };
    return signingRequire(id);
  };
  const load = vm.runInNewContext("(function(require,module,exports,process){" + source + "\n})");
  load(mockedRequire, module, module.exports, { env: { TRAVIS: "true" } });
  await module.exports.createKeychain({
    tmpDir: {},
    currentDir: "/virtual/aiden-signing-test",
    cscLink: "/virtual/application.p12",
    cscKeyPassword: "application-password",
    cscILink: "/virtual/installer.p12",
    cscIKeyPassword: "installer-password",
  });
  return commands;
}

test("builder signing uses the keychain password for partition access and each certificate password for import", async () => {
  const source = await upstreamSource();
  const original = await signingCommands(source);
  assert.notEqual(
    original.find(([verb]) => verb === "set-key-partition-list")[5],
    original.find(([verb]) => verb === "create-keychain")[2],
  );
  const patched = patchKeychainSource(source);
  assert.equal(patchKeychainSource(patched), patched);
  const commands = await signingCommands(patched);
  const keychainPassword = commands.find(([verb]) => verb === "create-keychain")[2];
  assert.ok(keychainPassword);
  const partitions = commands.filter(([verb]) => verb === "set-key-partition-list");
  assert.equal(partitions.length, 2);
  for (const args of partitions) assert.equal(args[args.indexOf("-k") + 1], keychainPassword);
  const imports = commands.filter(([verb]) => verb === "import");
  assert.deepEqual(
    imports.map((args) => args[args.indexOf("-P") + 1]),
    ["application-password", "installer-password"],
  );
});

test("signing backport rejects unexpected source and version without writing partial edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-signing-patch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules/app-builder-lib");
  const codeRoot = path.join(packageRoot, "out/codeSign");
  await mkdir(codeRoot, { recursive: true });
  const codeFile = path.join(codeRoot, "macCodeSign.js");
  const source = await upstreamSource();
  await writeFile(codeFile, source);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "99.0.0" }));
  await assert.rejects(patchElectronBuilderKeychain(root), /review the signing backport/);
  assert.equal(await readFile(codeFile, "utf8"), source);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ version: "26.15.3" }));
  const drift = source.replace('"-s", "-k", password, keychainFile', '"unexpected command"');
  await writeFile(codeFile, drift);
  await assert.rejects(patchElectronBuilderKeychain(root), /implementation changed/);
  assert.equal(await readFile(codeFile, "utf8"), drift);
  await writeFile(codeFile, source);
  assert.deepEqual(await patchElectronBuilderKeychain(root), { changed: true });
  assert.deepEqual(await patchElectronBuilderKeychain(root), { changed: false });
});
