// scripts/pullfrog-locked-runtime.mjs
import process2 from "node:process";
import { registerHooks } from "node:module";
import { readFileSync as readFileSync2 } from "node:fs";
import { fileURLToPath as fileURLToPath2, URL } from "node:url";

// scripts/pullfrog-locked-runtime-core.mjs
import process from "node:process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
var PULLFROG_SOURCE_SHA = "0657d542f2e34565c6254d5c84581313e631cd90";
var INSTALLER_SHA256 = "c21f552d791c65cbab4ebbda979ab21ab24addfbe167a20a60abb9858e947388";
var SKILLS_SHA256 = "6749108d484db7425645f3dd980ec98974db907ba412453c9925401eda33e67b";
var VERSIONS = { "opencode-ai": "1.18.5", "@anthropic-ai/claude-code": "2.1.150" };
var INSTALLERS = ["installFromNpmTarball", "installFromGithub", "installFromGithubTarball", "installFromDirectTarball", "installFromCurl"];
function lockedNpmExecutable(params, installerUrl) {
  const version = Object.hasOwn(VERSIONS, params.packageName) ? VERSIONS[params.packageName] : void 0;
  if (!version || params.version !== version) throw new Error("Unreviewed Pullfrog executable requested.");
  if (!["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported locked Pullfrog executable platform.");
  const actionRoot = dirname(dirname(fileURLToPath(installerUrl)));
  const action = JSON.parse(readFileSync(join(actionRoot, "package.json"), "utf8"));
  if (action.name !== "pullfrog" || action.version !== "0.1.57" || action.devDependencies?.[params.packageName] !== version) throw new Error("Pullfrog action dependency pin changed.");
  const requireAction = createRequire(join(actionRoot, "package.json"));
  const packageFile = requireAction.resolve(`${params.packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  const binaryName = params.packageName === "opencode-ai" ? "opencode" : "claude";
  const nativeName = params.packageName === "opencode-ai" ? `opencode-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}` : `@anthropic-ai/claude-code-${process.platform}-${process.arch}`;
  if (pkg.version !== version || pkg.optionalDependencies?.[nativeName] !== version) throw new Error("Pullfrog native dependency pin changed.");
  const nativeFile = createRequire(packageFile).resolve(`${nativeName}/package.json`);
  const native = JSON.parse(readFileSync(nativeFile, "utf8"));
  if (native.name !== nativeName || native.version !== version) throw new Error("Pullfrog native package identity changed.");
  const root = realpathSync(dirname(nativeFile));
  for (const candidate of [`bin/${binaryName}`, `bin/${binaryName}.exe`, binaryName, `${binaryName}.exe`]) {
    let resolved;
    try {
      resolved = realpathSync(join(root, candidate));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const inside = relative(root, resolved);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || !statSync(resolved).isFile() || !(statSync(resolved).mode & 73)) throw new Error("Unsafe Pullfrog native executable.");
    return resolved;
  }
  throw new Error("Locked Pullfrog native executable is unavailable; runtime download is disabled.");
}
function rewritePullfrogInstaller(source, helperUrl) {
  if (createHash("sha256").update(source).digest("hex") !== INSTALLER_SHA256) throw new Error("Pullfrog installer source changed; review the execution chain.");
  let rewritten = source;
  for (const name of INSTALLERS) {
    const signature = `export async function ${name}(`;
    if (rewritten.split(signature).length !== 2) throw new Error("Unexpected Pullfrog installer exports.");
    rewritten = rewritten.replace(signature, `async function unused_${name}(`);
  }
  return `import { lockedNpmExecutable } from ${JSON.stringify(helperUrl)};
${rewritten}
` + INSTALLERS.map(
    (name) => name === "installFromNpmTarball" ? `export async function ${name}(params) { return lockedNpmExecutable(params, import.meta.url); }` : `export async function ${name}() { throw new Error("Pullfrog runtime downloads are disabled; use the frozen executable packages."); }`
  ).join("\n");
}
function rewritePullfrogSkills(source) {
  if (createHash("sha256").update(source).digest("hex") !== SKILLS_SHA256) throw new Error("Pullfrog skills source changed; review the execution chain.");
  const signature = "export function addSkill(";
  if (source.split(signature).length !== 2) throw new Error("Unexpected Pullfrog skills exports.");
  return `${source.replace(signature, "function unused_addSkill(")}
export function addSkill(params) { log.warning(\`\${params.skill} skill not installed: runtime package installs are disabled.\`); }`;
}

// scripts/pullfrog-locked-runtime.mjs
var REWRITES = { "/utils/install.ts": rewritePullfrogInstaller, "/utils/skills.ts": rewritePullfrogSkills };
registerHooks({
  load(url, context, nextLoad) {
    const suffix = Object.keys(REWRITES).find((candidate) => url.endsWith(candidate));
    if (!url.startsWith("file:") || !suffix) return nextLoad(url, context);
    const packageUrl = new URL("../package.json", url);
    let packageName;
    try {
      packageName = JSON.parse(readFileSync2(packageUrl, "utf8")).name;
    } catch {
      return nextLoad(url, context);
    }
    if (packageName !== "pullfrog") return nextLoad(url, context);
    if (process2.env.GITHUB_ACTION_REPOSITORY !== "pullfrog/pullfrog" || process2.env.GITHUB_ACTION_REF !== PULLFROG_SOURCE_SHA) throw new Error("Unreviewed Pullfrog action identity.");
    const source = readFileSync2(fileURLToPath2(url), "utf8");
    const rewritten = REWRITES[suffix](source, import.meta.url);
    process2.stderr.write(`Pullfrog locked ${suffix === "/utils/install.ts" ? "executable installer" : "skill setup"} active.
`);
    return { format: "module-typescript", source: rewritten, shortCircuit: true };
  }
});
export {
  lockedNpmExecutable
};
