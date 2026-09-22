import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATIVE_UI_HOST_LIBS } from "../../renderer/shared/generative-ui.js";

const FILE_NAMES: Record<(typeof GENERATIVE_UI_HOST_LIBS)[number], string> = {
  "chart.js": "chart.umd.min.js",
  "plotly.js": "plotly.min.js",
  "katex.js": "katex.min.js",
  "katex.css": "katex.min.css",
  "react-grab-primitives.js": "react-grab-primitives.js",
};

function isPackagedElectron(): boolean {
  return Boolean(process.versions.electron) && process.defaultApp === undefined;
}

export function generativeUiLibraryDirectory(): string {
  const development = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../resources/generative-ui",
  );
  if (isPackagedElectron() && typeof process.resourcesPath === "string") {
    return path.join(process.resourcesPath, "generative-ui");
  }
  return development;
}

export function generativeUiLibraryPath(name: (typeof GENERATIVE_UI_HOST_LIBS)[number]): string {
  return path.join(generativeUiLibraryDirectory(), FILE_NAMES[name]);
}

export async function loadGenerativeUiHostLibraries(): Promise<Record<string, string>> {
  const libraries: Record<string, string> = {};
  for (const name of GENERATIVE_UI_HOST_LIBS) {
    let source: string;
    try {
      source = await fs.readFile(generativeUiLibraryPath(name), "utf8");
    } catch {
      throw new Error(
        `Host visualization library ${name} is missing. Reinstall Aiden or run npm run generative-ui:vendor.`,
      );
    }
    if (source.length === 0) {
      throw new Error(`Host visualization library ${name} is empty.`);
    }
    libraries[name] = source;
  }
  return libraries;
}

export async function readGenerativeUiHostLibrary(
  name: string,
): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
  const allowed = GENERATIVE_UI_HOST_LIBS.find((item) => item === name);
  if (!allowed) return undefined;
  try {
    const bytes = await fs.readFile(generativeUiLibraryPath(allowed));
    return {
      bytes,
      mimeType: allowed.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
    };
  } catch {
    return undefined;
  }
}
