// Child script for the offline test: lints each fixture named on the command
// line through the real worker and prints the outcomes as JSON.
import { readFileSync } from "node:fs";
import { runDesignMdWorker, type RunDesignMdWorkerOptions } from "../lint-client.js";

const mode = process.argv[2];
const files = process.argv.slice(3);
const optionsFor = (name: string | undefined): RunDesignMdWorkerOptions => {
  if (name === "explicit-execargv") return { execArgv: ["--import", "tsx"] };
  // The positive control: a worker that calls http.request under the trap.
  if (name === "calls-network") return { workerUrl: new URL("./calls-network.mjs", import.meta.url) };
  return {};
};
const outcomes = [];
for (const file of files) {
  const outcome = await runDesignMdWorker(
    { op: "lint", content: readFileSync(file, "utf8") },
    optionsFor(mode),
  );
  outcomes.push(outcome.ok ? { ok: true, summary: outcome.result.summary } : outcome);
}
process.stdout.write(JSON.stringify(outcomes));
