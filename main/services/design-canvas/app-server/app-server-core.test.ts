import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPackage,
  detectFramework,
  parsePackageJson,
  pickDevScript,
  safeScriptNames,
  type PackageJson,
} from "./app-server-core.js";

const NO_MARKERS = { workspaceRunnerFile: false };

function pkg(fields: { deps?: Record<string, string>; devDeps?: Record<string, string>; peerDeps?: Record<string, string>; scripts?: unknown }): PackageJson {
  return {
    name: "app",
    ...(fields.deps ? { dependencies: fields.deps } : {}),
    ...(fields.devDeps ? { devDependencies: fields.devDeps } : {}),
    ...(fields.peerDeps ? { peerDependencies: fields.peerDeps } : {}),
    ...(fields.scripts === undefined ? {} : { scripts: fields.scripts }),
  };
}

// ---- frameworks ----

test("each framework is found from dependencies or devDependencies, and peerDependencies are ignored", () => {
  const rows: Array<[string, string, string]> = [
    ["next", "15.0.0", "next"],
    ["@react-router/dev", "^7.0.0", "react-router"],
    ["@remix-run/dev", "^2.15.0", "remix"],
    ["remix", "^3.3.0", "remix-3"],
    ["@tanstack/react-start", "^1.120.0", "tanstack-start"],
    ["@tanstack/start", "^1.120.0", "tanstack-start"],
    ["nuxt", "^3.14.0", "nuxt"],
    ["@angular/build", "^19.0.0", "angular"],
    ["@angular-devkit/build-angular", "^17.0.0", "angular"],
    ["astro", "^5.0.0", "astro"],
    ["gatsby", "^5.0.0", "gatsby"],
    ["react-scripts", "5.0.1", "create-react-app"],
    ["@tanstack/router-plugin", "^1.0.0", "tanstack-router"],
    ["vite", "^6.0.0", "vite"],
  ];
  for (const [name, range, framework] of rows) {
    assert.equal(detectFramework(pkg({ deps: { [name]: range } })), framework, `${name} in dependencies`);
    assert.equal(detectFramework(pkg({ devDeps: { [name]: range } })), framework, `${name} in devDependencies`);
    assert.equal(detectFramework(pkg({ peerDeps: { [name]: range } })), undefined, `${name} in peerDependencies`);
  }
});

test("a framework app that also lists vite is that framework, not vite", () => {
  for (const [name, framework] of [
    ["@react-router/dev", "react-router"],
    ["@remix-run/dev", "remix"],
    ["@tanstack/react-start", "tanstack-start"],
    ["@tanstack/router-plugin", "tanstack-router"],
  ] as const) {
    assert.equal(detectFramework(pkg({ deps: { react: "^19.0.0" }, devDeps: { vite: "^6.0.0", [name]: "^1.0.0" } })), framework);
  }
  // A Next app that keeps vite around for Vitest is still Next.
  assert.equal(detectFramework(pkg({ deps: { next: "15.0.0" }, devDeps: { vite: "^6.0.0" } })), "next");
});

test("@react-router/dev wins over @remix-run/dev", () => {
  assert.equal(detectFramework(pkg({ devDeps: { "@remix-run/dev": "^2.15.0", "@react-router/dev": "^7.0.0" } })), "react-router");
});

test("react-router without @react-router/dev counts as the app's bundler", () => {
  assert.equal(detectFramework(pkg({ deps: { "react-router": "^7.0.0" }, devDeps: { vite: "^6.0.0" } })), "vite");
  assert.equal(detectFramework(pkg({ deps: { "react-router": "^7.0.0" } })), undefined);
});

test("remix 3 is its own framework and older remix is ignored", () => {
  for (const range of ["^3.0.0", "3.x", "~3.0.0", ">=3", "3.3.0", "^4.0.0"]) {
    assert.equal(detectFramework(pkg({ deps: { remix: range } })), "remix-3", range);
  }
  for (const range of ["^1.19.3", "2.17.0", "latest", "workspace:^"]) {
    assert.equal(detectFramework(pkg({ deps: { remix: range } })), undefined, range);
  }
});

// ---- dev script ----

test("the dev script is dev, then start, then serve, when none runs the framework's dev command", () => {
  const scripts = { serve: "node serve.js", start: "node start.js", dev: "node dev.js", build: "node build.js" };
  assert.equal(pickDevScript(pkg({ scripts }), "vite").script, "dev");
  assert.equal(pickDevScript(pkg({ scripts: { serve: scripts.serve, start: scripts.start } }), "vite").script, "start");
  assert.equal(pickDevScript(pkg({ scripts: { serve: scripts.serve, build: scripts.build } }), "vite").script, "serve");
  assert.deepEqual(pickDevScript(pkg({ scripts: { build: scripts.build } }), "vite"), {
    script: undefined,
    hadDevScript: false,
    skippedRunner: false,
  });
});

test("a script running the framework's dev command wins over an earlier one", () => {
  const cases: Array<[Record<string, string>, Parameters<typeof pickDevScript>[1], string]> = [
    [{ dev: "vite build --watch", start: "vite" }, "vite", "start"],
    [{ dev: "next dev || next start" }, "next", "dev"],
    [{ dev: "tsc -w & vite" }, "vite", "dev"],
    [{ dev: "node tools/check.js", start: "react-scripts start" }, "create-react-app", "start"],
    [{ dev: "node tools/check.js", start: "gatsby develop" }, "gatsby", "start"],
    [{ start: "node tools/check.js", dev: "ng serve" }, "angular", "dev"],
    [{ start: "node tools/check.js", dev: "nuxt dev" }, "nuxt", "dev"],
    [{ start: "node tools/check.js", dev: "vinxi dev" }, "tanstack-start", "dev"],
    [{ start: "NODE_ENV=production node --import remix/node-tsx server.ts", dev: "NODE_ENV=development node --watch --import remix/node-tsx server.ts" }, "remix-3", "dev"],
  ];
  for (const [scripts, framework, expected] of cases) {
    assert.equal(pickDevScript(pkg({ scripts }), framework).script, expected, JSON.stringify(scripts));
  }
});

test("builds, production runs, Storybook and workspace runners are passed over", () => {
  const skipped: Array<[Record<string, string>, boolean]> = [
    [{ start: "next start" }, false],
    [{ start: "next build && next start" }, false],
    [{ serve: "serve -s build" }, false],
    [{ start: "NODE_ENV=production node server.js" }, false],
    [{ dev: "tsup --watch" }, false],
    [{ dev: "rollup -c -w" }, false],
    [{ dev: "storybook dev -p 6006" }, false],
    [{ dev: "turbo dev" }, true],
    [{ dev: "nx serve web" }, true],
    [{ dev: "pnpm -r dev" }, true],
    [{ dev: "pnpm --filter web dev" }, true],
    [{ dev: "npm run dev --workspaces" }, true],
    [{ dev: "yarn workspaces foreach run dev" }, true],
    [{ dev: "lerna run dev" }, true],
  ];
  for (const [scripts, runner] of skipped) {
    // No framework, so only the skip list decides.
    assert.deepEqual(pickDevScript(pkg({ scripts }), undefined), { script: undefined, hadDevScript: true, skippedRunner: runner }, JSON.stringify(scripts));
  }
  // Tokens match only as words.
  assert.equal(pickDevScript(pkg({ scripts: { dev: "tscx serve" } }), undefined).script, "dev");
});

test("unsafe script names and non-string scripts are never picked or listed", () => {
  const long = "d".repeat(101);
  const scripts = { "-c": "vite", "dev\nx": "vite", [long]: "vite", dev: 42, start: null, ok: "vite" };
  assert.deepEqual(safeScriptNames(pkg({ scripts })), ["ok"]);
  assert.deepEqual(pickDevScript(pkg({ scripts }), "vite"), { script: undefined, hadDevScript: false, skippedRunner: false });
  assert.equal(safeScriptNames(pkg({ scripts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, "x"])) })).length, 50);
});

test("scripts that are missing or an array count as no scripts", () => {
  for (const scripts of [undefined, ["dev"], "vite", 42]) {
    const value = pkg({ devDeps: { vite: "^6.0.0" }, scripts });
    assert.deepEqual(safeScriptNames(value), []);
    assert.deepEqual(pickDevScript(value, "vite"), { script: undefined, hadDevScript: false, skippedRunner: false });
  }
});

// ---- kinds ----

test("an Electron app with React is react-nonweb desktop, even with vite and a dev script", () => {
  const aiden = pkg({ deps: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDeps: { electron: "43.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } });
  assert.deepEqual(classifyPackage(aiden, NO_MARKERS), {
    kind: "react-nonweb",
    reason: "desktop",
    desktopShell: "electron",
    framework: "vite",
    script: "dev",
    usesReact: true,
  });
});

test("a Tauri app with React is react-nonweb desktop", () => {
  const cli = classifyPackage(pkg({ deps: { react: "^19.0.0" }, devDeps: { "@tauri-apps/cli": "^2.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }), NO_MARKERS);
  assert.equal(cli.kind, "react-nonweb");
  assert.equal(cli.reason, "desktop");
  assert.equal(cli.desktopShell, "tauri");
  const api = classifyPackage(pkg({ deps: { react: "^19.0.0", "@tauri-apps/api": "^2.0.0" } }), NO_MARKERS);
  assert.equal(api.reason, "desktop");
  assert.equal(api.desktopShell, "tauri");
});

test("a desktop app without React is none", () => {
  const result = classifyPackage(pkg({ devDeps: { electron: "43.0.0", vite: "^6.0.0" }, scripts: { dev: "vite" } }), NO_MARKERS);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "desktop");
  assert.equal(result.desktopShell, "electron");
});

test("a turbo root is workspace-runner, not no-dev-script", () => {
  const result = classifyPackage(pkg({ devDeps: { turbo: "^2.0.0" }, scripts: { dev: "turbo dev", build: "turbo build" } }), NO_MARKERS);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "workspace-runner");
});

test("an Nx root with vite and react but no runnable script is workspace-runner", () => {
  const value = pkg({ deps: { react: "^19.0.0" }, devDeps: { vite: "^6.0.0", nx: "^20.0.0" }, scripts: {} });
  assert.equal(classifyPackage(value, { workspaceRunnerFile: true }).reason, "workspace-runner");
  // Without the marker the same package is a framework app with nothing to run.
  assert.equal(classifyPackage(value, NO_MARKERS).reason, "no-dev-script");
});

test("an Expo app is react-nonweb react-native", () => {
  const result = classifyPackage(pkg({ deps: { expo: "~52.0.0", react: "18.3.1", "react-native": "0.76.0" }, scripts: { start: "expo start" } }), NO_MARKERS);
  assert.equal(result.kind, "react-nonweb");
  assert.equal(result.reason, "react-native");
});

test("a vite app with no scripts at all is none no-dev-script", () => {
  const result = classifyPackage(pkg({ devDeps: { vite: "^6.0.0" } }), NO_MARKERS);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "no-dev-script");
  assert.equal(result.framework, "vite");
});

test("a Storybook-only React repo is react-nonweb, not no-dev-script", () => {
  const result = classifyPackage(
    pkg({ deps: { react: "^19.0.0" }, devDeps: { vite: "^6.0.0", "@storybook/react-vite": "^8.0.0" }, scripts: { storybook: "storybook dev -p 6006", "build-storybook": "storybook build" } }),
    NO_MARKERS,
  );
  assert.equal(result.kind, "react-nonweb");
  assert.equal(result.reason, "no-web-framework");
});

test("a React library whose dev only builds is react-nonweb, not no-dev-script", () => {
  const result = classifyPackage(
    pkg({ peerDeps: { react: "^19.0.0" }, devDeps: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite build --watch" } }),
    NO_MARKERS,
  );
  assert.equal(result.kind, "react-nonweb");
  assert.equal(result.reason, "no-web-framework");
});

test("a custom webpack app is none unknown-framework", () => {
  const result = classifyPackage(pkg({ deps: { react: "^19.0.0" }, devDeps: { webpack: "^5.0.0" }, scripts: { dev: "webpack serve" } }), NO_MARKERS);
  assert.equal(result.kind, "none");
  assert.equal(result.reason, "unknown-framework");
  assert.equal(result.script, "dev");
});

test("a React package with no framework and no scripts is react-nonweb no-web-framework", () => {
  assert.deepEqual(classifyPackage(pkg({ deps: { react: "^19.0.0" } }), NO_MARKERS), {
    kind: "react-nonweb",
    reason: "no-web-framework",
    usesReact: true,
  });
  assert.deepEqual(classifyPackage(pkg({ deps: { lodash: "^4.0.0" } }), NO_MARKERS), {
    kind: "none",
    reason: "no-web-framework",
    usesReact: false,
  });
});

test("a vite Vue app is web and does not use React", () => {
  assert.deepEqual(classifyPackage(pkg({ deps: { vue: "^3.5.0" }, devDeps: { vite: "^6.0.0" }, scripts: { dev: "vite", build: "vite build" } }), NO_MARKERS), {
    kind: "web",
    reason: "ok",
    framework: "vite",
    script: "dev",
    usesReact: false,
  });
});

test("an Angular app is web, and a Nuxt app is web", () => {
  const angular = classifyPackage(pkg({ deps: { "@angular/core": "^19.0.0" }, devDeps: { "@angular/build": "^19.0.0" }, scripts: { start: "ng serve" } }), NO_MARKERS);
  assert.equal(angular.kind, "web");
  assert.equal(angular.framework, "angular");
  assert.equal(angular.script, "start");
  const nuxt = classifyPackage(pkg({ deps: { nuxt: "^3.14.0" }, scripts: { dev: "nuxt dev" } }), NO_MARKERS);
  assert.equal(nuxt.kind, "web");
  assert.equal(nuxt.framework, "nuxt");
});

test("an unreadable package.json is none invalid-package-json", () => {
  assert.deepEqual(classifyPackage(null, NO_MARKERS), { kind: "none", reason: "invalid-package-json", usesReact: false });
});

test("parsePackageJson strips a BOM and returns null for arrays, strings and broken JSON", () => {
  assert.deepEqual(parsePackageJson('\uFEFF{"name":"web"}'), { name: "web" });
  for (const text of ["[]", '"vite"', "null", "42", "{", ""]) {
    assert.equal(parsePackageJson(text), null, text);
  }
});
