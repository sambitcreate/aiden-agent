import { spawn } from "node:child_process";
import process from "node:process";
import { benchmarkStamp } from "./performance-fixture.mjs";

const stamp = benchmarkStamp("visible-idle", "packaged");
const child = spawn("npm", ["run", "package"], {
  stdio: "inherit",
  env: {
    ...process.env,
    AIDEN_REACT_PROFILING: "1",
    AIDEN_BUILD_COMMIT: stamp.commit,
    AIDEN_BUILD_DIRTY_HASH: stamp.dirtyStateHash,
    AIDEN_BUILD_MODE: "packaged",
  },
});
child.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  const exitCode = signal ? 1 : (code ?? 1);
  if (exitCode === 0) {
    try {
      const after = benchmarkStamp("visible-idle", "packaged");
      if (after.commit !== stamp.commit || after.dirtyStateHash !== stamp.dirtyStateHash) {
        throw new Error("Source changed while the profiling package was built.");
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = exitCode;
});
