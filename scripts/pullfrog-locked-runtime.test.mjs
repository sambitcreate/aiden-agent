import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { lockedNpmExecutable, rewritePullfrogInstaller } from "./pullfrog-locked-runtime-core.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "aiden-locked-pullfrog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const json = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
  json(join(root, "package.json"), { name: "pullfrog", version: "0.1.57", type: "module", devDependencies: { "opencode-ai": "1.18.5" } });
  const name = `opencode-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}`;
  json(join(root, "node_modules/opencode-ai/package.json"), { version: "1.18.5", optionalDependencies: { [name]: "1.18.5" } });
  const native = join(root, "node_modules", name);
  json(join(native, "package.json"), { name, version: "1.18.5" });
  mkdirSync(join(native, "bin"), { recursive: true });
  const executable = join(native, "bin/opencode");
  writeFileSync(executable, "#!/bin/sh\nprintf locked-runtime", { mode: 0o700 });
  mkdirSync(join(root, "utils"));
  return { root, executable, installer: pathToFileURL(join(root, "utils/install.mjs")).href, json, native };
}

test("the runtime uses the frozen native dependency without downloading or executing an installer", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const executable = lockedNpmExecutable({ packageName: "opencode-ai", version: "1.18.5", installDependencies: true }, f.installer);
  assert.equal(executable, realpathSync(f.executable));
  assert.equal(execFileSync(executable, { encoding: "utf8" }), "locked-runtime");
  assert.throws(() => lockedNpmExecutable({ packageName: "opencode-ai", version: "^1.18.5" }, f.installer), /Unreviewed/);
  f.json(join(f.native, "package.json"), { name: "wrong-package", version: "1.18.5" });
  assert.throws(() => lockedNpmExecutable({ packageName: "opencode-ai", version: "1.18.5" }, f.installer), /identity changed/);
});

test("missing native packages fail closed instead of falling back to installation", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t); rmSync(f.executable);
  assert.throws(() => lockedNpmExecutable({ packageName: "opencode-ai", version: "1.18.5" }, f.installer), /runtime download is disabled/);
});

test("rewritten executable routes never call the original runtime installers", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const names = ["installFromNpmTarball", "installFromGithub", "installFromGithubTarball", "installFromDirectTarball", "installFromCurl"];
  const source = readFileSync(new URL("./fixtures/pullfrog-0.1.57-install.ts.fixture", import.meta.url), "utf8");
  assert.throws(() => rewritePullfrogInstaller(source + "changed", import.meta.url), /source changed/);
  const rewritten = rewritePullfrogInstaller(source, new URL("./pullfrog-locked-runtime-core.mjs", import.meta.url).href);
  writeFileSync(join(f.root, "utils/cli.ts"), "export const log = {};\n");
  f.installer = pathToFileURL(join(f.root, "utils/install.ts")).href;
  writeFileSync(new URL(f.installer), rewritten);
  const installer = await import(f.installer);
  assert.equal(await installer.installFromNpmTarball({ packageName: "opencode-ai", version: "1.18.5" }), realpathSync(f.executable));
  for (const name of names.slice(1)) await assert.rejects(installer[name]({}), /runtime downloads are disabled/);
  writeFileSync(new URL(f.installer), source);
  const output = execFileSync(process.execPath, ["--import", new URL("./pullfrog-locked-runtime.mjs", import.meta.url).href, "--input-type=module", "-e",
    `const installer = await import(${JSON.stringify(f.installer)}); process.stdout.write(await installer.installFromNpmTarball({packageName:"opencode-ai",version:"1.18.5"}));`],
    { encoding: "utf8", env: { ...process.env, GITHUB_ACTION_REPOSITORY: "pullfrog/pullfrog", GITHUB_ACTION_REF: "0657d542f2e34565c6254d5c84581313e631cd90" }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(output, realpathSync(f.executable));
});
