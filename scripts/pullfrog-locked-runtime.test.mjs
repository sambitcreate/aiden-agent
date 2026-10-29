import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { lockedNpmExecutable, rewritePullfrogInstaller, rewritePullfrogSkills } from "./pullfrog-locked-runtime-core.mjs";

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


test("automatic skill setup never reaches npx through the locked runtime", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const source = readFileSync(new URL("./fixtures/pullfrog-0.1.57-skills.ts.fixture", import.meta.url), "utf8");
  assert.throws(() => rewritePullfrogSkills(source + "changed"), /source changed/);
  writeFileSync(join(f.root, "utils/skills.ts"), source);
  writeFileSync(join(f.root, "utils/cli.ts"), "export const log = { success: (m: string) => process.stdout.write(`success:${m}\\n`), warning: (m: string) => process.stdout.write(`warning:${m}\\n`) };\n");
  writeFileSync(join(f.root, "utils/version.ts"), 'export const getDevDependencyVersion = (_name: string) => "1.4.9";\n');
  // A stand-in npx records any call; the original addSkill would spawn it.
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const marker = join(f.root, "npx-ran");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  const call = `const m = await import(${JSON.stringify(pathToFileURL(join(f.root, "utils/skills.ts")).href)}); m.addSkill({ ref: "vercel-labs/agent-browser@v1", skill: "agent-browser", env: {}, agent: "claude-code" });`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTION_REPOSITORY: "pullfrog/pullfrog", GITHUB_ACTION_REF: "0657d542f2e34565c6254d5c84581313e631cd90" };
  const output = execFileSync(process.execPath, ["--import", new URL("./pullfrog-locked-runtime.mjs", import.meta.url).href, "--input-type=module", "-e", call], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.match(output, /agent-browser skill not installed/);
  assert.equal(existsSync(marker), false, "the locked runtime never ran npx");
  // Positive control: without the hook the same call does run npx.
  execFileSync(process.execPath, ["--input-type=module", "-e", call], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(existsSync(marker), true);
});

test("immutable bootstrap blob is integrity checked and survives a hostile review checkout", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const workflow = parse(readFileSync(new URL("../.github/workflows/pullfrog.yml", import.meta.url), "utf8"));
  const step = workflow.jobs.pullfrog.steps.find(step => step.id === "bootstrap");
  const preload = readFileSync(new URL("./pullfrog-runtime-preload.mjs", import.meta.url));
  const compiled = await build({
    absWorkingDir: new URL("../", import.meta.url).pathname,
    entryPoints: ["scripts/pullfrog-locked-runtime.mjs"], outfile: "scripts/pullfrog-runtime-preload.mjs",
    bundle: true, platform: "node", format: "esm", target: "node22", write: false,
  });
  assert.equal(createHash("sha256").update(compiled.outputFiles[0].contents).digest("hex"), createHash("sha256").update(preload).digest("hex"),
    "the enforcing blob must compile from the reviewed source");
  assert.equal(step.env.BOOTSTRAP_SHA256, createHash("sha256").update(preload).digest("hex"));
  assert.equal(step.env.BOOTSTRAP_BLOB, createHash("sha1").update(`blob ${preload.length}\0`).update(preload).digest("hex"));
  const bin = join(f.root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_GH_RESPONSE);\n', { mode: 0o700 });
  const output = join(f.root, "outputs");
  const response = { encoding: "base64", size: preload.length, content: preload.toString("base64") };
  const env = { ...process.env, ...step.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, FAKE_GH_RESPONSE: JSON.stringify(response) };
  execFileSync("bash", ["-e", "-c", step.run], { env, stdio: ["ignore", "pipe", "pipe"] });
  const nodeOptions = readFileSync(output, "utf8").trim().slice("node_options=".length);
  assert.ok(nodeOptions.startsWith("--import=data:text/javascript;base64,"));
  // There is no enforcing module import from these mutable workspace files.
  mkdirSync(join(f.root, "scripts"));
  writeFileSync(join(f.root, "scripts/pullfrog-locked-runtime.mjs"), 'throw new Error("hostile checkout preload executed");');
  writeFileSync(join(f.root, "scripts/pullfrog-locked-runtime-core.mjs"), 'throw new Error("hostile checkout core executed");');
  const source = readFileSync(new URL("./fixtures/pullfrog-0.1.57-install.ts.fixture", import.meta.url), "utf8");
  const installer = pathToFileURL(join(f.root, "utils/install.ts")).href;
  writeFileSync(new URL(installer), source);
  writeFileSync(join(f.root, "utils/cli.ts"), "export const log = {};\n");
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(installer)}); process.stdout.write(await m.installFromNpmTarball({packageName:"opencode-ai",version:"1.18.5"}));`], {
    cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: nodeOptions, GITHUB_ACTION_REPOSITORY: "pullfrog/pullfrog", GITHUB_ACTION_REF: "0657d542f2e34565c6254d5c84581313e631cd90" },
  });
  assert.equal(result, realpathSync(f.executable));
  rmSync(output);
  assert.throws(() => execFileSync("bash", ["-e", "-c", step.run], {
    env: { ...env, FAKE_GH_RESPONSE: JSON.stringify({ ...response, content: Buffer.from("unreviewed").toString("base64") }) }, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.throws(() => readFileSync(output, "utf8"), { code: "ENOENT" });
});
