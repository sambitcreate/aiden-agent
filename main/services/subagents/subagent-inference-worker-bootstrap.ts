import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// UtilityProcess owns one provider request but cannot own a POSIX descendant
// group. Disable every Node subprocess entry point before provider modules are
// loaded so profile credential_process hooks cannot escape cancellation.
const subprocessDisabled = () => {
  throw new Error("Provider credential subprocesses are disabled in isolated subagent inference.");
};

for (const name of [
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
] as const) {
  Object.defineProperty(childProcess, name, {
    value: subprocessDisabled,
    configurable: false,
    enumerable: true,
    writable: false,
  });
}

// Supported Node/Electron releases do not currently expose this namespace,
// but define it as a closed trap so a future child_process promises surface
// cannot silently bypass the top-level lockdown.
Object.defineProperty(childProcess, "promises", {
  value: Object.freeze({
    exec: subprocessDisabled,
    execFile: subprocessDisabled,
    fork: subprocessDisabled,
    spawn: subprocessDisabled,
  }),
  configurable: false,
  enumerable: true,
  writable: false,
});

// Keep later ESM named imports (for example `import { exec }`) bound to the
// disabled functions rather than Node's original built-in export cells.
syncBuiltinESMExports();

const runtimeModule = "./subagent-inference-worker-runtime.js";
try {
  await import(runtimeModule);
} catch (error) {
  // This runs before the request protocol exists, so stderr is the only
  // reliable parent-owned channel. Main captures only a bounded pre-ready
  // tail, redacts it, and never forwards it to renderer state or Pi journals.
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : "Unknown bootstrap failure";
  const forcedExit = setTimeout(() => process.exit(1), 100);
  process.stderr.write(`AIDEN_SUBAGENT_BOOTSTRAP_FAILURE\n${detail}\n`, () => {
    clearTimeout(forcedExit);
    process.exit(1);
  });
}
