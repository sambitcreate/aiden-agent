import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectNextPreviewRuntimeAdapters,
  nextPreviewLaunchArguments,
} from "./source-preview-next-runtime-adapter.js";

async function fixture(input: {
  version: string;
  command: string;
  files: Record<string, string>;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-next-preview-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: input.command }, dependencies: { next: input.version } }),
  );
  for (const [relativePath, contents] of Object.entries(input.files)) {
    const filePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  return root;
}

test("detects an App Router webpack project and preserves server/client route boundaries", async () => {
  const root = await fixture({
    version: "15.4.1",
    command: "next dev --webpack",
    files: {
      "next.config.ts": "export default {}",
      "app/page.tsx": "export default function Page() { return <main /> }",
      "app/dashboard/page.tsx":
        "'use client'; export default function Dashboard() { return <main /> }",
      "app/(account)/settings/[team]/page.tsx":
        "export default function Settings() { return null }",
    },
  });
  try {
    const [adapter] = await detectNextPreviewRuntimeAdapters(root, {
      sourceGraphState: "current",
      manifestFormatVersion: 1,
    });
    assert.ok(adapter);
    assert.equal(adapter.router, "app");
    assert.equal(adapter.bundler, "webpack");
    assert.equal(adapter.configPath, "next.config.ts");
    assert.deepEqual(
      adapter.routes.map((route) => [route.routePath, route.boundary, route.classification.status]),
      [
        ["/settings/:team", "server", "preview-only"],
        ["/dashboard", "client", "supported"],
        ["/", "server", "preview-only"],
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detects Pages Router routes and Next 16 Turbopack default separately", async () => {
  const root = await fixture({
    version: "^16.0.2",
    command: "next dev",
    files: {
      "pages/index.tsx": "export default function Home() { return null }",
      "pages/blog/[slug].tsx": "export default function Post() { return null }",
      "pages/api/private.ts": "export default function handler() {}",
      "pages/_app.tsx": "export default function App() {}",
    },
  });
  try {
    const [adapter] = await detectNextPreviewRuntimeAdapters(root, {
      sourceGraphState: "current",
      manifestFormatVersion: 1,
    });
    assert.ok(adapter);
    assert.equal(adapter.router, "pages");
    assert.equal(adapter.bundler, "turbopack");
    assert.deepEqual(
      adapter.routes.map((route) => [route.routePath, route.boundary, route.classification]),
      [
        [
          "/blog/:slug",
          "client",
          {
            status: "supported",
            adapter: "next-pages-turbopack",
            hmr: "requires-loopback-proof",
            sourceSelection: "manifest-required",
            directEdit: "review-required",
          },
        ],
        [
          "/",
          "client",
          {
            status: "supported",
            adapter: "next-pages-turbopack",
            hmr: "requires-loopback-proof",
            sourceSelection: "manifest-required",
            directEdit: "review-required",
          },
        ],
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detects explicit Turbopack and rejects conflicting bundler authority", async () => {
  const turboRoot = await fixture({
    version: "15.5.0",
    command: "next dev --turbopack",
    files: { "src/app/page.tsx": "'use client'; export default function Page() { return null }" },
  });
  const ambiguousRoot = await fixture({
    version: "16.0.0",
    command: "next dev --turbopack --webpack",
    files: { "app/page.tsx": "'use client'; export default function Page() { return null }" },
  });
  try {
    assert.equal((await detectNextPreviewRuntimeAdapters(turboRoot))[0]?.bundler, "turbopack");
    const ambiguous = (await detectNextPreviewRuntimeAdapters(ambiguousRoot))[0];
    assert.equal(ambiguous?.bundler, "ambiguous");
    assert.equal(ambiguous?.routes[0]?.classification.status, "unsupported");
  } finally {
    await fs.rm(turboRoot, { recursive: true, force: true });
    await fs.rm(ambiguousRoot, { recursive: true, force: true });
  }
});

test("hybrid projects preserve per-route adapters while symlinked routes are ignored", async () => {
  const root = await fixture({
    version: "15.4.1",
    command: "next dev --webpack",
    files: {
      "app/page.tsx": "'use client'; export default function AppPage() { return null }",
      "pages/legacy.tsx": "export default function Legacy() { return null }",
    },
  });
  const outside = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "aiden-next-outside-")),
    "page.tsx",
  );
  await fs.writeFile(outside, "'use client'; export default function Escaped() { return null }");
  await fs.symlink(outside, path.join(root, "app", "escaped.tsx"));
  try {
    const [adapter] = await detectNextPreviewRuntimeAdapters(root, {
      sourceGraphState: "current",
      manifestFormatVersion: 1,
    });
    assert.equal(adapter?.router, "hybrid");
    assert.deepEqual(
      adapter?.routes.map((route) => [route.entryPath, route.classification.status]),
      [
        ["app/page.tsx", "supported"],
        ["pages/legacy.tsx", "supported"],
      ],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(path.dirname(outside), { recursive: true, force: true });
  }
});

test("only exact next dev scripts are detected and launch is shell-free on fixed loopback", async () => {
  const root = await fixture({
    version: "15.4.1",
    command: "next build",
    files: { "app/page.tsx": "export default function Page() { return null }" },
  });
  try {
    assert.deepEqual(await detectNextPreviewRuntimeAdapters(root), []);
    assert.deepEqual(nextPreviewLaunchArguments("pnpm", "dev", 3_001), {
      command: "pnpm",
      args: ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3001"],
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
