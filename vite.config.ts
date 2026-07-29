import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig(({ command }) => {
  const appDisplayName = command === "serve" ? "Aiden Agent Dev" : "Aiden Agent";
  return {
    plugins: [react(), tailwindcss()],
    base: "./",
    define: { __APP_DISPLAY_NAME__: JSON.stringify(appDisplayName) },
    resolve: {
      alias: {
        "@renderer": resolve(import.meta.dirname, "renderer"),
        "@main": resolve(import.meta.dirname, "main"),
      },
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
