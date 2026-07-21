/* global console, fetch, process */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildArtificialAnalysisSnapshot,
  validateModelsDevSnapshot,
} from "./model-snapshot-core.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDevDestination = resolve(projectRoot, "resources", "model-capabilities.json");
const artificialAnalysisDestination = resolve(
  projectRoot,
  "resources",
  "artificial-analysis-models.json",
);
const promptType = "long";

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Snapshot request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 240)}` : ""}`,
    );
  }
  return response.json();
}

async function fetchModelsDev() {
  return validateModelsDevSnapshot(
    await fetchJson("https://models.dev/api.json", {
      headers: { accept: "application/json" },
    }),
  );
}

async function fetchArtificialAnalysisPages(apiKey) {
  const headers = { accept: "application/json", "x-api-key": apiKey };
  const endpoint = "https://artificialanalysis.ai/api/v2/language/models";
  const first = await fetchJson(`${endpoint}?prompt_type=${promptType}&page=1`, { headers });
  const totalPages = first?.pagination?.total_pages;
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 100) {
    throw new Error("Artificial Analysis returned invalid pagination metadata.");
  }
  const remainder = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      fetchJson(`${endpoint}?prompt_type=${promptType}&page=${index + 2}`, { headers }),
    ),
  );
  return [first, ...remainder];
}

async function writeSnapshots(modelsDev, artificialAnalysis) {
  const suffix = `.tmp-${process.pid}`;
  const modelsDevTemporary = modelsDevDestination + suffix;
  const artificialAnalysisTemporary = artificialAnalysisDestination + suffix;
  await mkdir(dirname(modelsDevDestination), { recursive: true });
  try {
    await Promise.all([
      writeFile(modelsDevTemporary, JSON.stringify(modelsDev, null, 2) + "\n", "utf8"),
      writeFile(
        artificialAnalysisTemporary,
        JSON.stringify(artificialAnalysis, null, 2) + "\n",
        "utf8",
      ),
    ]);
    await rename(modelsDevTemporary, modelsDevDestination);
    await rename(artificialAnalysisTemporary, artificialAnalysisDestination);
  } catch (error) {
    await Promise.all([
      unlink(modelsDevTemporary).catch(() => undefined),
      unlink(artificialAnalysisTemporary).catch(() => undefined),
    ]);
    throw error;
  }
}

async function main() {
  const apiKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim() || process.env.AA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Set ARTIFICIAL_ANALYSIS_API_KEY (or AA_API_KEY) before refreshing release model snapshots.",
    );
  }
  if (process.env.AA_REDISTRIBUTION_CONFIRMED !== "1") {
    throw new Error(
      "Set AA_REDISTRIBUTION_CONFIRMED=1 only after Artificial Analysis redistribution rights are confirmed.",
    );
  }

  const fetchedAt = new Date().toISOString();
  const [modelsDev, pages] = await Promise.all([
    fetchModelsDev(),
    fetchArtificialAnalysisPages(apiKey),
  ]);
  const artificialAnalysis = buildArtificialAnalysisSnapshot(pages, {
    fetchedAt,
    redistributionConfirmed: true,
    promptType,
  });
  await writeSnapshots(modelsDev, artificialAnalysis);
  console.log(
    `Updated release snapshots: ${Object.keys(modelsDev).length} models.dev providers and ${artificialAnalysis.models.length} Artificial Analysis models.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
