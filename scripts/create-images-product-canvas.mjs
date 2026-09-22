/* global process */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { waitForBoundedChild } from "./bounded-child.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "build", "create-images-product-canvas");
const rendererAssets = path.join(repositoryRoot, "build", "renderer", "assets");
const entry = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "create-images-product-canvas-entry.tsx",
);
const main = path.join(
  repositoryRoot,
  "scripts",
  "fixtures",
  "create-images-canvas-spike-main.cjs",
);
const page = path.join(outputDirectory, "index.html");
const screenshot = path.join(outputDirectory, "product-canvas.png");
const electron = path.join(repositoryRoot, "node_modules", ".bin", "electron");

const builtAssets = await fs.readdir(rendererAssets);
const productStyles = builtAssets.filter((name) => name.endsWith(".css"));
if (productStyles.length < 2) {
  throw new Error("Build the production renderer before running the product canvas gate.");
}

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
for (const name of productStyles) {
  await fs.copyFile(path.join(rendererAssets, name), path.join(outputDirectory, name));
}
const stylesheetLinks = ["bundle.css", ...productStyles]
  .map((name) => `    <link rel="stylesheet" href="./${name}" />`)
  .join("\n");
await fs.writeFile(
  page,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
${stylesheetLinks}
    <title>Create Images product canvas gate</title>
  </head>
  <body><script type="module" src="./bundle.js"></script></body>
</html>
`,
  "utf8",
);

const child = spawn(electron, [main, page, screenshot], {
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
    label: "Product canvas gate",
    timeoutMs: 60_000,
  });
} catch (error) {
  throw new Error(`${error.message}\n${stderr || stdout}`, { cause: error });
}
if (outcome.code !== 0 || outcome.signal !== null) {
  throw new Error(
    `Product canvas gate failed with ${outcome.code ?? outcome.signal}.\n${stderr || stdout}`,
  );
}
const line = stdout
  .split(/\r?\n/u)
  .find((candidate) => candidate.startsWith("AIDEN_CREATE_IMAGES_SPIKE="));
if (!line) throw new Error(`Product canvas gate returned no result.\n${stderr || stdout}`);
const result = JSON.parse(line.slice("AIDEN_CREATE_IMAGES_SPIKE=".length));
if (result.error) throw new Error(result.error);

const failures = [];
for (const measurement of result.cases) {
  const renderLimit = measurement.nodeCount === 100 ? 1_250 : 2_000;
  if (measurement.initialRenderMs > renderLimit) {
    failures.push(
      `${measurement.nodeCount}-node product render ${measurement.initialRenderMs.toFixed(1)}ms > ${renderLimit}ms`,
    );
  }
  if (measurement.averageViewportOperationMs > 16.7) {
    failures.push(
      `${measurement.nodeCount}-node viewport average ${measurement.averageViewportOperationMs.toFixed(1)}ms > 16.7ms`,
    );
  }
  if (measurement.medianSelectionMutationMs > 5) {
    failures.push(
      `${measurement.nodeCount}-node selection mutation median ${measurement.medianSelectionMutationMs.toFixed(2)}ms > 5ms`,
    );
  }
  if (measurement.medianAdjustedSelectionMs > 8) {
    failures.push(
      `${measurement.nodeCount}-node baseline-adjusted selection median ${measurement.medianAdjustedSelectionMs.toFixed(2)}ms > 8ms`,
    );
  }
  if (measurement.hostWidth !== 1000 || measurement.hostHeight !== 650) {
    failures.push(`${measurement.nodeCount}-node host did not remain 1000x650`);
  }
  if (measurement.instanceNodeCount !== measurement.nodeCount) {
    failures.push(
      `${measurement.nodeCount}-node fixture settled with ${measurement.instanceNodeCount} nodes`,
    );
  }
  if (
    measurement.renderedNodeCount < 1 ||
    measurement.renderedNodeCount >= measurement.instanceNodeCount ||
    measurement.renderedNodeCount > 64
  ) {
    failures.push(
      `${measurement.nodeCount}-node fixture rendered ${measurement.renderedNodeCount} DOM nodes; expected visible-node culling within 1–64 nodes`,
    );
  }
  if (measurement.layoutNodesMeasured < 4 || measurement.overlappingVisibleNodePairs !== 0) {
    failures.push(
      `${measurement.nodeCount}-node fixture measured ${measurement.layoutNodesMeasured} layout nodes with ${measurement.overlappingVisibleNodePairs} overlapping pairs`,
    );
  }
  if (!measurement.longPromptEditorScrollable) {
    failures.push(
      `${measurement.nodeCount}-node fixture did not bound and internally scroll a 32K prompt`,
    );
  }
  if (!measurement.editOperationsPassed) {
    failures.push(`${measurement.nodeCount}-node duplicate/undo/redo/delete sequence failed`);
  }
  if (!measurement.repeatedAnnouncementPassed) {
    failures.push(
      `${measurement.nodeCount}-node fixture did not mutate the live region for repeated announcements`,
    );
  }
  if (
    !measurement.resolvedThemeSurface ||
    measurement.resolvedThemeSurface === "rgba(0, 0, 0, 0)"
  ) {
    failures.push(`${measurement.nodeCount}-node theme surface did not resolve`);
  }
  if (measurement.longTaskCount > 8) {
    failures.push(
      `${measurement.nodeCount}-node fixture produced ${measurement.longTaskCount} long tasks`,
    );
  }
}
if (typeof result.heapGrowthBytes === "number" && result.heapGrowthBytes > 80 * 1024 * 1024) {
  failures.push(`heap growth ${result.heapGrowthBytes} bytes > 80 MB`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length > 0) {
  throw new Error(`Product canvas performance gate failed:\n- ${failures.join("\n- ")}`);
}
