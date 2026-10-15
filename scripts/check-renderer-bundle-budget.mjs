/* global console, process */
/**
 * Fails when the JavaScript the main window must load before first paint (its
 * entry module plus every modulepreload) grows past the budget. Lazy chunks
 * are not counted: moving code behind a dynamic import is the intended fix.
 *
 *   npm run build && npm run check:bundle-budget
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// About 3 % above the measured size when the budget was introduced. Raise it
// deliberately, with a reason in the PR, rather than to make CI pass.
export const MAIN_WINDOW_INITIAL_JS_BUDGET = Object.freeze({ raw: 3_520_000, gzip: 1_075_000 });

const TAG = /<(script|link)\b[^>]*>/giu;
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "iu"))?.[1];

/** Lists the scripts an HTML entry loads eagerly: module scripts and modulepreloads. */
export function initialScripts(html) {
  const scripts = [];
  for (const [tag, element] of html.matchAll(TAG)) {
    const source = element.toLowerCase() === "script"
      ? attribute(tag, "src")
      : attribute(tag, "rel")?.toLowerCase() === "modulepreload" ? attribute(tag, "href") : undefined;
    if (source && !/^[a-z][a-z0-9+.-]*:/iu.test(source) && !scripts.includes(source)) scripts.push(source);
  }
  return scripts;
}

export async function measureInitialJavaScript(htmlPath) {
  const html = await readFile(htmlPath, "utf8");
  const files = [];
  for (const source of initialScripts(html)) {
    const contents = await readFile(path.resolve(path.dirname(htmlPath), source));
    files.push({ source, raw: contents.length, gzip: gzipSync(contents, { level: 9 }).length });
  }
  return {
    files,
    raw: files.reduce((total, file) => total + file.raw, 0),
    gzip: files.reduce((total, file) => total + file.gzip, 0),
  };
}

export function budgetViolations(measurement, budget = MAIN_WINDOW_INITIAL_JS_BUDGET) {
  return ["raw", "gzip"]
    .filter((kind) => measurement[kind] > budget[kind])
    .map((kind) => `${kind} ${measurement[kind]} B exceeds the ${budget[kind]} B budget`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const htmlPath = path.join(repositoryRoot, "build", "renderer", "main-window.html");
  const measurement = await measureInitialJavaScript(htmlPath);
  if (measurement.files.length === 0) throw new Error(`${htmlPath} loads no scripts; run npm run build first.`);
  for (const file of measurement.files) console.log(`${file.source}: ${file.raw} B raw, ${file.gzip} B gzip`);
  console.log(`Main window initial JS: ${measurement.raw} B raw, ${measurement.gzip} B gzip`);
  const violations = budgetViolations(measurement);
  if (violations.length > 0) {
    console.error(`Main window initial JS is over budget: ${violations.join("; ")}.`);
    process.exit(1);
  }
}
