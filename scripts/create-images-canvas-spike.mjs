/* global process */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { waitForBoundedChild } from "./bounded-child.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "build", "create-images-canvas-spike");
const entry = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "create-images-canvas-spike-entry.tsx",
);
const main = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "create-images-canvas-spike-main.cjs",
);
const page = path.join(outputDirectory, "index.html");
const electron = path.join(repositoryRoot, "node_modules", ".bin", "electron");

await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [entry],
  outfile: path.join(outputDirectory, "bundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome142",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warning",
});
await fs.writeFile(
  page,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="./bundle.css" />
    <title>Create Images canvas spike</title>
  </head>
  <body><script type="module" src="./bundle.js"></script></body>
</html>
`,
  "utf8",
);

const child = spawn(electron, [main, page], {
  cwd: repositoryRoot,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
let outcome;
try {
  outcome = await waitForBoundedChild(child, {
    label: "Canvas spike",
    timeoutMs: 40_000,
  });
} catch (error) {
  throw new Error(`${error.message}\n${stderr || stdout}`, { cause: error });
}
if (outcome.code !== 0 || outcome.signal !== null) {
  throw new Error(`Canvas spike failed with ${outcome.code ?? outcome.signal}.\n${stderr || stdout}`);
}
const line = stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("AIDEN_CREATE_IMAGES_SPIKE="));
if (!line) throw new Error(`Canvas spike returned no result.\n${stderr || stdout}`);
const result = JSON.parse(line.slice("AIDEN_CREATE_IMAGES_SPIKE=".length));
if (result.error) throw new Error(result.error);

const failures = [];
for (const measurement of result.cases) {
  const renderLimit = measurement.nodeCount === 100 ? 1_000 : 1_500;
  if (measurement.initialRenderMs > renderLimit) {
    failures.push(
      `${measurement.nodeCount}-node render ${measurement.initialRenderMs.toFixed(1)}ms > ${renderLimit}ms`,
    );
  }
  if (measurement.averageViewportOperationMs > 16.7) {
    failures.push(
      `${measurement.nodeCount}-node viewport average ${measurement.averageViewportOperationMs.toFixed(1)}ms > 16.7ms`,
    );
  }
  if (measurement.averageSelectionOperationMs > 25) {
    failures.push(
      `${measurement.nodeCount}-node selection frame average ${measurement.averageSelectionOperationMs.toFixed(1)}ms > 25ms`,
    );
  }
  if (measurement.hostWidth !== 1000 || measurement.hostHeight !== 650) {
    failures.push(
      `${measurement.nodeCount}-node host was ${measurement.hostWidth}x${measurement.hostHeight}, expected 1000x650`,
    );
  }
  if (measurement.instanceNodeCount !== measurement.nodeCount) {
    failures.push(
      `${measurement.nodeCount}-node fixture loaded ${measurement.instanceNodeCount} graph nodes`,
    );
  }
  if (measurement.renderedNodeCount < 1) {
    failures.push(`${measurement.nodeCount}-node fixture rendered no visible nodes`);
  }
  if (measurement.longTaskCount > 5) {
    failures.push(
      `${measurement.nodeCount}-node fixture produced ${measurement.longTaskCount} long tasks`,
    );
  }
}
if (typeof result.heapGrowthBytes === "number" && result.heapGrowthBytes > 64 * 1024 * 1024) {
  failures.push(`heap growth ${result.heapGrowthBytes} bytes > 64 MB`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length > 0)
  throw new Error(`Canvas performance gate failed:\n- ${failures.join("\n- ")}`);
