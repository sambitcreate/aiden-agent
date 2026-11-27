import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Inside the fixture copy, so the dep optimizer never writes into the repo's
  // node_modules through the symlink.
  cacheDir: ".vite-cache",
  plugins: [react()],
});
