/* global console, process */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const REQUIRED_PAGES = ["main-window.html", "pill.html", "visual-snapshot.html"];

export function assertProductionRendererCsp(html, name = "renderer page") {
  const policies = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/giu)];
  if (policies.length !== 1) throw new Error(`${name} must declare exactly one CSP.`);
  const directives = new Map(policies[0][1].split(";").map(directive => {
    const [name, ...sources] = directive.trim().split(/\s+/u);
    return [name, sources];
  }));
  for (const directive of ["script-src", "style-src"]) {
    const sources = directives.get(directive);
    if (!sources?.includes("'self'")) throw new Error(`${directive} must allow the shipped assets in ${name}.`);
    if (sources.some(source => /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/u.test(source))) {
      throw new Error(`${directive} allows development code loading in ${name}.`);
    }
  }
}

export function verifyPackagedRendererCsp(asar) {
  const pages = listPackage(asar, { isPack: false })
    .map(entry => entry.replaceAll("\\", "/").replace(/^\//u, ""))
    .filter(entry => entry.startsWith("build/renderer/") && entry.endsWith(".html"));
  for (const page of REQUIRED_PAGES) {
    if (!pages.includes(`build/renderer/${page}`)) throw new Error(`Packaged renderer is missing ${page}.`);
  }
  for (const page of pages) assertProductionRendererCsp(extractFile(asar, page).toString("utf8"), page);
}

export async function verifyRendererBuildCsp(directory) {
  const files = await readdir(directory, { recursive: true });
  for (const page of REQUIRED_PAGES) if (!files.includes(page)) throw new Error(`Renderer build is missing ${page}.`);
  for (const page of files.filter(file => file.endsWith(".html"))) {
    assertProductionRendererCsp(await readFile(path.join(directory, page), "utf8"), page);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: node scripts/verify-renderer-csp.mjs <renderer build directory>");
  await verifyRendererBuildCsp(directory);
  console.log("Verified production CSP for every built renderer HTML page.");
}
