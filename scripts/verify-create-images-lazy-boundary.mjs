/* global console, process */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyCreateImagesLazyBoundary(
  assetsDirectory = path.join(repositoryRoot, "build", "renderer", "assets"),
) {
  const names = await fs.readdir(assetsDirectory);
  const mainMapName = names.find(
    (name) => name.startsWith("main-window-") && name.endsWith(".js.map"),
  );
  if (!mainMapName) throw new Error("Create Images lazy-boundary check found no main-window map.");
  const mainMap = JSON.parse(await fs.readFile(path.join(assetsDirectory, mainMapName), "utf8"));
  const eagerSources = Array.isArray(mainMap.sources) ? mainMap.sources : [];
  for (const forbidden of [
    "/renderer/create-images/fixtures.ts",
    "/renderer/shared/create-images/schema.ts",
  ]) {
    if (eagerSources.some((source) => source.replaceAll("\\", "/").endsWith(forbidden))) {
      throw new Error(`Create Images lazy-boundary check found eager source ${forbidden}.`);
    }
  }

  const cssEntries = await Promise.all(
    names
      .filter((name) => name.endsWith(".css"))
      .map(async (name) => ({ name, source: await fs.readFile(path.join(assetsDirectory, name), "utf8") })),
  );
  const globalCss = cssEntries.find((entry) => entry.source.includes(".chat-content-column"));
  if (!globalCss) throw new Error("Create Images lazy-boundary check found no global renderer CSS.");
  if (globalCss.source.includes(".create-images-workbench")) {
    throw new Error("Create Images CSS leaked into the eager global stylesheet.");
  }
  const routeCss = cssEntries.find((entry) => entry.source.includes(".create-images-workbench"));
  if (!routeCss) throw new Error("Create Images route CSS was not emitted in a lazy chunk.");

  const mainProcessDirectory = path.join(repositoryRoot, "build", "main");
  const mainProcessMap = JSON.parse(
    await fs.readFile(path.join(mainProcessDirectory, "index.js.map"), "utf8"),
  );
  const runnerSuffix = "/main/services/create-images/packaged-canvas-acceptance-runner.ts";
  if (
    (mainProcessMap.sources ?? []).some((source) =>
      source.replaceAll("\\", "/").endsWith(runnerSuffix),
    )
  ) {
    throw new Error("Packaged Create Images acceptance automation leaked into eager main startup.");
  }
  const mainProcessEntries = await fs.readdir(path.join(mainProcessDirectory, "chunks"));
  let runnerChunkName;
  for (const name of mainProcessEntries.filter((entry) => entry.endsWith(".js.map"))) {
    const map = JSON.parse(
      await fs.readFile(path.join(mainProcessDirectory, "chunks", name), "utf8"),
    );
    if ((map.sources ?? []).some((source) => source.replaceAll("\\", "/").endsWith(runnerSuffix))) {
      runnerChunkName = name.replace(/\.map$/u, "");
      break;
    }
  }
  if (!runnerChunkName) {
    throw new Error("Packaged Create Images acceptance automation did not emit a lazy main chunk.");
  }

  return {
    mainMapName,
    globalCssName: globalCss.name,
    routeCssName: routeCss.name,
    runnerChunkName,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyCreateImagesLazyBoundary();
  console.log(`Verified Create Images lazy boundary: ${JSON.stringify(result)}`);
}
