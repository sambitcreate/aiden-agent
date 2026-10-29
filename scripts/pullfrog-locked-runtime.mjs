import process from "node:process";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { PULLFROG_SOURCE_SHA, rewritePullfrogInstaller, rewritePullfrogSkills } from "./pullfrog-locked-runtime-core.mjs";
export { lockedNpmExecutable } from "./pullfrog-locked-runtime-core.mjs";

// --import is inherited by the action's commit-local cli.ts subprocess. Only
// its known installer and skill setup are replaced; all other module loading remains native.
const REWRITES = { "/utils/install.ts": rewritePullfrogInstaller, "/utils/skills.ts": rewritePullfrogSkills };

registerHooks({
  load(url, context, nextLoad) {
    const suffix = Object.keys(REWRITES).find((candidate) => url.endsWith(candidate));
    if (!url.startsWith("file:") || !suffix) return nextLoad(url, context);
    // A customer's own utils/install.ts or utils/skills.ts is unrelated to this source hook.
    const packageUrl = new URL("../package.json", url);
    let packageName;
    try { packageName = JSON.parse(readFileSync(packageUrl, "utf8")).name; } catch { return nextLoad(url, context); }
    if (packageName !== "pullfrog") return nextLoad(url, context);
    if (process.env.GITHUB_ACTION_REPOSITORY !== "pullfrog/pullfrog" || process.env.GITHUB_ACTION_REF !== PULLFROG_SOURCE_SHA) throw new Error("Unreviewed Pullfrog action identity.");
    const source = readFileSync(fileURLToPath(url), "utf8");
    const rewritten = REWRITES[suffix](source, import.meta.url);
    process.stderr.write(`Pullfrog locked ${suffix === "/utils/install.ts" ? "executable installer" : "skill setup"} active.\n`);
    return { format: "module-typescript", source: rewritten, shortCircuit: true };
  },
});
