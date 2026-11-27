import { appendFileSync } from "node:fs";

export function appendGithubOutput(lines, outputPath) {
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export function appendGithubSummary(lines, summaryPath) {
  if (!summaryPath) {
    return;
  }
  const summary = lines.at(-1);
  appendFileSync(summaryPath, `${summary.slice("summary=".length)}\n`, "utf8");
}
