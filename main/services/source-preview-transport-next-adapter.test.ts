import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNextSourceAdapter,
  parseNextSourceAdapterFixture,
  type NextBoundaryFixtureKind,
  type NextBundlerFixtureKind,
  type NextRouterFixtureKind,
  type NextSourceGraphFixtureState,
} from "./source-preview-transport-next-adapter.js";

function fixture(overrides?: {
  router?: NextRouterFixtureKind;
  bundler?: NextBundlerFixtureKind;
  boundary?: NextBoundaryFixtureKind;
  graph?: NextSourceGraphFixtureState;
  manifestFormatVersion?: number;
  devKind?: "next-dev" | "other";
  controlledLoopbackHost?: boolean;
  controlledPort?: boolean;
}) {
  return {
    version: 1,
    framework: "next",
    nextVersion: "15.4.1",
    devCommand: {
      kind: overrides?.devKind ?? "next-dev",
      scriptId: "dev",
      controlledLoopbackHost: overrides?.controlledLoopbackHost ?? true,
      controlledPort: overrides?.controlledPort ?? true,
    },
    routerFixture: {
      kind: overrides?.router ?? "app",
      routePath: "/dashboard",
      entryPath:
        (overrides?.router ?? "app") === "pages" ? "pages/dashboard.tsx" : "app/dashboard/page.tsx",
    },
    bundlerFixture: {
      kind: overrides?.bundler ?? "webpack",
      configPath: "next.config.ts",
    },
    boundaryFixture: {
      kind: overrides?.boundary ?? "client",
      evidencePath: "components/Dashboard.tsx",
    },
    sourceGraphFixture: {
      state: overrides?.graph ?? "current",
      manifestFormatVersion: overrides?.manifestFormatVersion ?? 1,
    },
  };
}

test("classifies App/Pages Router against webpack/Turbopack as separate supported fixtures", () => {
  const cases = [
    ["app", "webpack", "next-app-webpack"],
    ["app", "turbopack", "next-app-turbopack"],
    ["pages", "webpack", "next-pages-webpack"],
    ["pages", "turbopack", "next-pages-turbopack"],
  ] as const;
  for (const [router, bundler, adapter] of cases) {
    assert.deepEqual(classifyNextSourceAdapter(fixture({ router, bundler })), {
      status: "supported",
      adapter,
      hmr: "requires-loopback-proof",
      sourceSelection: "manifest-required",
      directEdit: "review-required",
    });
  }
});

test("server, mixed, and unknown boundaries remain preview-only", () => {
  for (const [boundary, reason] of [
    ["server", "server-boundary"],
    ["mixed", "mixed-boundary"],
    ["unknown", "unknown-boundary"],
  ] as const) {
    assert.deepEqual(classifyNextSourceAdapter(fixture({ boundary })), {
      status: "preview-only",
      adapter: "next-app-webpack",
      reason,
      hmr: "requires-loopback-proof",
      sourceSelection: "disabled",
    });
  }
});

test("missing, stale, ambiguous, and version-skewed source graphs remain preview-only", () => {
  for (const [graph, reason] of [
    ["missing", "source-graph-missing"],
    ["stale", "source-graph-stale"],
    ["ambiguous", "source-graph-ambiguous"],
  ] as const) {
    assert.deepEqual(classifyNextSourceAdapter(fixture({ graph })), {
      status: "preview-only",
      adapter: "next-app-webpack",
      reason,
      hmr: "requires-loopback-proof",
      sourceSelection: "disabled",
    });
  }
  assert.deepEqual(classifyNextSourceAdapter(fixture({ manifestFormatVersion: 2 })), {
    status: "preview-only",
    adapter: "next-app-webpack",
    reason: "source-graph-version-unsupported",
    hmr: "requires-loopback-proof",
    sourceSelection: "disabled",
  });
});

test("ambiguous router/bundler and uncontrolled commands are unsupported", () => {
  const cases = [
    [fixture({ router: "none" }), "missing-router"],
    [fixture({ router: "hybrid" }), "hybrid-router-ambiguous"],
    [fixture({ bundler: "ambiguous" }), "bundler-ambiguous"],
    [fixture({ bundler: "unknown" }), "bundler-unknown"],
    [fixture({ devKind: "other" }), "unsupported-dev-command"],
    [fixture({ controlledLoopbackHost: false }), "uncontrolled-preview-target"],
    [fixture({ controlledPort: false }), "uncontrolled-preview-target"],
  ] as const;
  for (const [value, reason] of cases) {
    assert.deepEqual(classifyNextSourceAdapter(value), { status: "unsupported", reason });
  }
});

test("fixture parsing is exact, bounded, and path-safe", () => {
  const value = fixture();
  assert.ok(parseNextSourceAdapterFixture(value));
  assert.equal(parseNextSourceAdapterFixture({ ...value, command: "npm run anything" }), undefined);
  assert.equal(
    parseNextSourceAdapterFixture({
      ...value,
      routerFixture: { ...value.routerFixture, entryPath: "../outside/page.tsx" },
    }),
    undefined,
  );
  assert.equal(
    parseNextSourceAdapterFixture({
      ...value,
      boundaryFixture: { ...value.boundaryFixture, contents: "source code is forbidden" },
    }),
    undefined,
  );
  assert.equal(classifyNextSourceAdapter({ ...value, framework: "vite" }).status, "unsupported");
});

test("classification is data-only and never accepts commands, process IDs, URLs, or source bytes", () => {
  const value = fixture();
  for (const forbidden of [
    { command: "next dev" },
    { processId: 1234 },
    { previewUrl: "http://127.0.0.1:3000" },
    { source: "export default function Page() {}" },
  ]) {
    assert.equal(parseNextSourceAdapterFixture({ ...value, ...forbidden }), undefined);
  }
});
