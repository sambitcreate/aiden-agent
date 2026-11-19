import { Script } from "node:vm";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { clippedUnicode } from "../../renderer/shared/unicode-prefix.js";
import { formatCheckReport } from "./check-report.js";

/** Scripts past this many are counted as not checked. */
const MAX_SCRIPTS_CHECKED = 64;
const MAX_MESSAGE_CHARS = 200;
const FILENAME = "visual.html";

/** The `type` values a browser runs as a classic script (WHATWG HTML, "JavaScript MIME type essence match"). */
const CLASSIC_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

export interface GenerativeUiScriptCheck {
  /** One sentence per script that will not run, naming its line in the HTML. */
  findings: string[];
  /** Scripts that were not checked, and why. */
  unchecked: string[];
  /** How many inline scripts were compiled. */
  checked: number;
}

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name && !attr.namespace)?.value;
}

/**
 * The script's type as a browser works it out (WHATWG HTML, "prepare the
 * script element"): its `type`, or when it has none, "text/" and its
 * `language`, so `<script language="vbscript">` is not JavaScript.
 */
function scriptType(script: Element): string {
  const type = attribute(script, "type");
  if (type !== undefined) return type.trim().toLowerCase();
  const language = attribute(script, "language");
  return language ? `text/${language}`.trim().toLowerCase() : "";
}

/**
 * The HTML line of the script line V8 names first in a SyntaxError's stack
 * ("visual.html:12"). V8 also ends a line at U+2028 and U+2029, which an
 * HTML editor shows inside one line, so those breaks before the error are
 * taken back out.
 */
function errorLine(error: Error, text: string, start: number): number {
  const match = /^visual\.html:(\d+)/u.exec(error.stack ?? "");
  if (!match) return start;
  let breaks = Number(match[1]) - start;
  let separators = 0;
  for (const found of text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)) {
    if (breaks <= 0) break;
    breaks -= 1;
    if (found[0] === "\u2028" || found[0] === "\u2029") separators += 1;
  }
  return Number(match[1]) - separators;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return clippedUnicode(flat, MAX_MESSAGE_CHARS);
}

/**
 * Compiles every inline script a raw HTML visual would run, without running
 * any of them, so a typo that stops a script is reported with its line
 * instead of leaving a visual that draws nothing. Module scripts, scripts
 * inside a `<template>`, data blocks (`type="application/json"`) and scripts
 * in another language (`language="vbscript"`) are not compiled: modules can't be compiled here without running them, and the
 * others never run as written.
 */
export function checkGenerativeUiScripts(html: string): GenerativeUiScriptCheck {
  const findings: string[] = [];
  const unchecked: string[] = [];
  let document: DefaultTreeAdapterTypes.Document;
  try {
    document = parse(html, { sourceCodeLocationInfo: true });
  } catch {
    return { findings, unchecked: ["the HTML could not be read to find its scripts"], checked: 0 };
  }
  let seen = 0;
  let modules = 0;
  let skipped = 0;
  const stack: Node[] = [document];
  const scripts: Element[] = [];
  while (stack.length) {
    const node = stack.pop() as Node;
    if (isElement(node) && node.tagName === "script") scripts.push(node);
    // A template's content lives outside childNodes, so its scripts are not visited.
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index -= 1) stack.push(node.childNodes[index]);
  }
  for (const script of scripts) {
    if (attribute(script, "src") !== undefined) continue;
    const type = scriptType(script);
    if (type === "module") {
      modules += 1;
      continue;
    }
    if (!CLASSIC_TYPES.has(type)) continue;
    const text = script.childNodes.map((child) => ("value" in child && child.nodeName === "#text" ? child.value : "")).join("");
    if (!text.trim()) continue;
    seen += 1;
    if (seen > MAX_SCRIPTS_CHECKED) {
      skipped += 1;
      continue;
    }
    const at = script.childNodes[0]?.sourceCodeLocation ?? script.sourceCodeLocation;
    const line = at?.startLine ?? 1;
    try {
      // Compiling only parses: nothing in the script runs in the main process.
      new Script(text, { filename: FILENAME, lineOffset: line - 1, columnOffset: (at?.startCol ?? 1) - 1 });
    } catch (error) {
      if (error instanceof SyntaxError) {
        findings.push(
          `The script starting on line ${line} will not run: ${clip(error.message)} (line ${errorLine(error, text, line)}). The reader sees the visual without anything that script draws or wires up.`,
        );
      } else {
        unchecked.push(`the script starting on line ${line}, which is too deeply nested to read`);
      }
    }
  }
  if (skipped) unchecked.push(`${skipped} more script${skipped === 1 ? "" : "s"} past the first ${MAX_SCRIPTS_CHECKED}`);
  if (modules) unchecked.push(`${modules} module script${modules === 1 ? "" : "s"} (type="module")`);
  return { findings, unchecked, checked: Math.min(seen, MAX_SCRIPTS_CHECKED) };
}

/** The script check as text for the end of render_artifact's result; empty when there were no scripts to check. */
export function describeGenerativeUiScriptCheck(check: GenerativeUiScriptCheck, rerun: string): string {
  if (!check.checked && !check.unchecked.length) return "";
  return formatCheckReport({
    label: "Script check",
    findings: check.findings,
    fix: `The visual is shown as written. Fix them and ${rerun}.`,
    unchecked: check.unchecked,
    clean:
      check.checked === 0
        ? "no inline script could be compiled here"
        : check.checked === 1
          ? "its inline script compiles"
          : `all ${check.checked} inline scripts compile`,
  });
}
