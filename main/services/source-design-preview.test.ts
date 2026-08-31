import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectSourcePreviewScripts, injectSourceDesignerScripts } from "./source-design-preview.js";

test("detects only explicit Vite development scripts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-source-preview-"));
  try {
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          storybook: "vite --config storybook.config.ts",
          build: "vite build",
          unsafe: "next dev",
        },
      }),
    );
    assert.deepEqual(await detectSourcePreviewScripts(root), [
      {
        id: "dev",
        label: "Development app",
        command: "pnpm run dev -- --host 127.0.0.1 --port <port> --strictPort",
      },
      {
        id: "storybook",
        label: "storybook",
        command: "pnpm run storybook -- --host 127.0.0.1 --port <port> --strictPort",
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("injects the exact-selection bridge before the closing body", () => {
  const html = injectSourceDesignerScripts("<!doctype html><body><main>App</main></body>");
  assert.match(html, /__aiden_design__\/react-grab\.js/u);
  assert.match(html, /__aiden_design__\/bridge\.js/u);
  assert.ok(html.indexOf("bridge.js") < html.indexOf("</body>"));
});
