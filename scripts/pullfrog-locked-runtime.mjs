import process from "node:process";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { PULLFROG_SOURCE_SHA, rewritePullfrogInstaller } from "./pullfrog-locked-runtime-core.mjs";

// --import is inherited by the action's commit-local cli.ts subprocess. Only
// its known installer is replaced; all other module loading remains native.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith("/utils/install.ts")) return nextLoad(url, context);
    // A customer's own utils/install.ts is unrelated to this source hook.
    const packageUrl = new URL("../package.json", url);
    let packageName;
    try { packageName = JSON.parse(readFileSync(packageUrl, "utf8")).name; } catch { return nextLoad(url, context); }
    if (packageName !== "pullfrog") return nextLoad(url, context);
    if (process.env.GITHUB_ACTION_REPOSITORY !== "pullfrog/pullfrog" || process.env.GITHUB_ACTION_REF !== PULLFROG_SOURCE_SHA) throw new Error("Unreviewed Pullfrog action identity.");
    const source = readFileSync(fileURLToPath(url), "utf8");
    const rewritten = rewritePullfrogInstaller(source, new URL("./pullfrog-locked-runtime-core.mjs", import.meta.url).href);
    process.stderr.write("Pullfrog locked executable installer active.\n");
    return { format: "module-typescript", source: rewritten, shortCircuit: true };
  },
});
