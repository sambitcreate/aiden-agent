import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [mode, file, gate, marker, resultFile] = process.argv.slice(2);
if (mode === "pause-reclaim") {
  const remove = fs.rmSync;
  fs.rmSync = (target, ...args) => {
    if (target === `${file}.lock`) {
      fs.writeFileSync(marker, "paused");
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(gate)) Atomics.wait(cell, 0, 0, 10);
    }
    return remove(target, ...args);
  };
  syncBuiltinESMExports();
}

const { acquireLease } = await import("../../dist/parity-test-api.js");
try {
  acquireLease(file);
  fs.writeFileSync(resultFile, `owned:${process.pid}`);
  setInterval(() => undefined, 60_000);
} catch (error) {
  fs.writeFileSync(resultFile, `contended:${String(error)}`);
}
