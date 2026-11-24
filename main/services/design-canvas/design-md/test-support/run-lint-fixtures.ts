// Child script for the offline test: lints each fixture named on the command
// line through the real worker and prints the outcomes as JSON.
import { readFileSync } from "node:fs";
import { runDesignMdWorker } from "../lint-client.js";

const mode = process.argv[2];
const files = process.argv.slice(3);
const outcomes = [];
for (const file of files) {
  const outcome = await runDesignMdWorker(
    { op: "lint", content: readFileSync(file, "utf8") },
    mode === "explicit-execargv" ? { execArgv: ["--import", "tsx"] } : {},
  );
  outcomes.push(outcome.ok ? { ok: true, summary: outcome.result.summary } : outcome);
}
process.stdout.write(JSON.stringify(outcomes));
