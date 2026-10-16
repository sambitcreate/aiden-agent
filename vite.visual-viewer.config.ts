import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * KaTeX lists each font as woff2, woff and ttf. Both phone web views read
 * woff2, so the inlined fallbacks only triple the document's size.
 */
function woff2OnlyFonts(): Plugin {
  return {
    name: "aiden-visual-viewer-woff2-only",
    apply: "build",
    enforce: "post",
    // Lib-mode CSS is emitted after `generateBundle`, so rewrite the written file.
    writeBundle(options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith(".css") || !options.dir) continue;
        const file = resolve(options.dir, fileName);
        const source = readFileSync(file, "utf8");
        writeFileSync(file, source.replace(/,\s*url\(data:font\/(?:woff|ttf);[^)]*\)\s*format\("(?:woff|truetype)"\)/gu, ""));
      }
    },
  };
}

/**
 * The phone visual viewer (`renderer/visual-viewer/`): one IIFE script and one
 * stylesheet with every asset inlined, so main can serve a visual to iOS and
 * Android as a single self-contained document. Built after the main renderer
 * build into `build/renderer/visual-viewer/`, which ships with the renderer.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), woff2OnlyFonts()],
  // The renderer's public files (worklets, icons) are not part of a visual.
  publicDir: false,
  define: {
    __APP_DISPLAY_NAME__: JSON.stringify("Aiden Agent"),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "@renderer": resolve(import.meta.dirname, "renderer"),
      "@main": resolve(import.meta.dirname, "main"),
    },
  },
  build: {
    outDir: "build/renderer/visual-viewer",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(import.meta.dirname, "renderer/visual-viewer/main.tsx"),
      name: "AidenVisualViewer",
      formats: ["iife"],
      fileName: () => "viewer.js",
      cssFileName: "viewer",
    },
  },
});
