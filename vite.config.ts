import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ command }) => {
  const appDisplayName = command === "serve" ? "Aiden Agent Dev" : "Aiden Agent";
  const profilingBuild = command === "build" && process.env.AIDEN_REACT_PROFILING === "1";
  return {
    plugins: [react(), tailwindcss()],
    base: "./",
    define: {
      __APP_DISPLAY_NAME__: JSON.stringify(appDisplayName),
      __AIDEN_REACT_PROFILING__: JSON.stringify(profilingBuild),
    },
    resolve: {
      alias: [
        ...(profilingBuild
          ? [
              {
                find: "react-dom/client",
                replacement: resolve(import.meta.dirname, "node_modules/react-dom/profiling.js"),
              },
            ]
          : []),
        { find: "@renderer", replacement: resolve(import.meta.dirname, "renderer") },
        { find: "@main", replacement: resolve(import.meta.dirname, "main") },
      ],
    },
    build: {
      outDir: "build/renderer",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          "main-window": resolve(import.meta.dirname, "main-window.html"),
          pill: resolve(import.meta.dirname, "pill.html"),
        },
      },
    },
  };
});
