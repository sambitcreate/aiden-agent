import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(modulePath), "..");

export const GENERATIVE_UI_VENDOR_SOURCES = Object.freeze({
  "chart.umd.min.js": ["chart.js", "dist", "chart.umd.min.js"],
  "plotly.min.js": ["plotly.js-dist-min", "plotly.min.js"],
  "katex.min.js": ["katex", "dist", "katex.min.js"],
  "katex.min.css": ["katex", "dist", "katex.min.css"],
});

export const REACT_GRAB_PRIMITIVES_FILENAME = "react-grab-primitives.js";
export const REACT_GRAB_PRIMITIVES_ENTRY = `
import {
  getElementAtPoint,
  getElementBounds,
  getElementSelector,
  isElementGrabbable,
} from "react-grab/primitives";
globalThis.AidenReactGrabPrimitives = Object.freeze({
  getElementAtPoint,
  getElementBounds,
  getElementSelector,
  isElementGrabbable,
});
`;

const FONT_BASENAME = /^KaTeX_[A-Za-z0-9._-]+\.(woff2|woff|ttf)$/u;

export function vendorSourcePath(root, segments) {
  return path.join(root, "node_modules", ...segments);
}

export function vendorDestinationDirectory(root = repositoryRoot) {
  return path.join(root, "resources", "generative-ui");
}

function mimeForFont(filename) {
  if (filename.endsWith(".woff2")) return "font/woff2";
  if (filename.endsWith(".woff")) return "font/woff";
  return "font/ttf";
}

export async function inlineKatexFonts(css, fontsDirectory) {
  return css.replace(/url\((['"]?)([^)'"]+)\1\)/gu, (match, _quote, rawUrl) => {
    const cleaned = rawUrl.split("?")[0]?.split("#")[0] ?? "";
    if (cleaned.startsWith("data:")) return match;
    const basename = path.basename(cleaned);
    if (!FONT_BASENAME.test(basename)) {
      throw new Error(`Unexpected KaTeX font URL: ${rawUrl}`);
    }
    const fontPath = path.join(fontsDirectory, basename);
    if (path.basename(fontPath) !== basename) {
      throw new Error(`Rejected KaTeX font path: ${rawUrl}`);
    }
    return `url("data:${mimeForFont(basename)};base64,{{${basename}}}")`;
  });
}

async function replaceFontPlaceholders(css, fontsDirectory) {
  const names = [...css.matchAll(/\{\{([^}]+)\}\}/gu)].map((entry) => entry[1]);
  let result = css;
  for (const name of new Set(names)) {
    if (!name || !FONT_BASENAME.test(name)) {
      throw new Error(`Unexpected KaTeX font placeholder: ${name ?? ""}`);
    }
    const bytes = await readFile(path.join(fontsDirectory, name));
    result = result.replaceAll(`{{${name}}}`, bytes.toString("base64"));
  }
  return result;
}

export async function vendorGenerativeUiLibraries(root = repositoryRoot) {
  const destination = vendorDestinationDirectory(root);
  await mkdir(destination, { recursive: true });
  for (const [filename, segments] of Object.entries(GENERATIVE_UI_VENDOR_SOURCES)) {
    const source = vendorSourcePath(root, segments);
    if (!source.startsWith(path.join(root, "node_modules") + path.sep)) {
      throw new Error(`Refusing to vendor from outside node_modules: ${source}`);
    }
    let contents = await readFile(source);
    if (filename === "katex.min.css") {
      const fontsDirectory = path.join(root, "node_modules", "katex", "dist", "fonts");
      const rewritten = await inlineKatexFonts(contents.toString("utf8"), fontsDirectory);
      contents = Buffer.from(await replaceFontPlaceholders(rewritten, fontsDirectory), "utf8");
    }
    await writeFile(path.join(destination, filename), contents, { mode: 0o644 });
  }
  const { build } = await import("esbuild");
  const bundled = await build({
    stdin: {
      contents: REACT_GRAB_PRIMITIVES_ENTRY,
      resolveDir: root,
      sourcefile: "aiden-react-grab-primitives-entry.js",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome124",
    minify: true,
    legalComments: "inline",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    banner: {
      js: "/* React Grab primitives, Copyright (c) 2025 Aiden Bai, MIT License. */",
    },
    write: false,
  });
  const output = bundled.outputFiles?.[0]?.contents;
  if (!output || output.byteLength === 0) {
    throw new Error("React Grab primitives bundle is empty.");
  }
  await writeFile(path.join(destination, REACT_GRAB_PRIMITIVES_FILENAME), output, { mode: 0o644 });
  return destination;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (invokedDirectly) {
  await vendorGenerativeUiLibraries();
}
