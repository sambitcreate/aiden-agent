/* global console, process */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

// The main window frames generated UI, design files and, in design mode, the
// loopback apps the frame guard admits. Chromium ignores `http://[::1]:*`
// there, so it is left out (design mode v2 Phase 3a, D11, deviation 9).
const MAIN_WINDOW_FRAME_SRC = ["'self'", "aiden-genui:", "aiden-design:", "http://localhost:*", "http://127.0.0.1:*"];
const LOOPBACK_FRAME_SOURCE = /^http:\/\/(?:localhost|127\.0\.0\.1):(?:\*|\d{1,5})$/u;

function frameSourceAllowed(source) {
  return source === "'self'" || source === "'none'" || /^aiden-[a-z]+:$/u.test(source) || LOOPBACK_FRAME_SOURCE.test(source);
}

function assertFrameSrc(directives, name) {
  const declared = directives.get("frame-src");
  if (name === "main-window.html" || name.endsWith("/main-window.html")) {
    if (declared && (declared.length !== MAIN_WINDOW_FRAME_SRC.length || new Set(declared).size !== declared.length || !MAIN_WINDOW_FRAME_SRC.every(source => declared.includes(source)))) {
      throw new Error(`frame-src in ${name} must be exactly ${MAIN_WINDOW_FRAME_SRC.join(" ")}.`);
    }
  }
  // Without frame-src (or child-src), default-src decides what may be framed.
  const effective = declared ?? directives.get("child-src") ?? directives.get("default-src") ?? [];
  const wide = effective.find(source => !frameSourceAllowed(source));
  if (wide) throw new Error(`frame-src in ${name} allows ${wide}; pages may frame only themselves, Aiden schemes and loopback.`);
}

const REQUIRED_PAGES = ["main-window.html", "pill.html", "quick-chat.html", "bot-bubbles.html", "visual-snapshot.html"];

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
  assertFrameSrc(directives, name);
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
