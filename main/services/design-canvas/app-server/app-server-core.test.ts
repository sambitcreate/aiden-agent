import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPackage,
  decidePackageManager,
  designTarget,
  detectFramework,
  installCommand,
  installedMarkerManagers,
  lockfileManagers,
  matchesWorkspacePattern,
  parsePackageJson,
  parsePackageManagerField,
  pickDevScript,
  runScriptCommand,
  safeScriptNames,
  workspacePatterns,
  type DetectedApp,
  type PackageJson,
  type PackageManagerInfo,
  type PackageManagerSignals,
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
    // Root scripts that hand off to one member.
    [{ dev: "npm run dev -w apps/web" }, true],
    [{ dev: "npm run dev --workspace web" }, true],
    [{ dev: "npm run dev --workspace=web" }, true],
    [{ dev: "yarn workspace web dev" }, true],
    [{ dev: "npm --prefix apps/web run dev" }, true],
    [{ dev: "pnpm -C apps/web dev" }, true],
    [{ dev: "pnpm --dir apps/web dev" }, true],
    [{ dev: 'concurrently "npm:dev:*"' }, true],
    [{ dev: "npm-run-all --parallel dev:*" }, true],
    [{ dev: "run-p dev:*" }, true],
  ];
  for (const [scripts, runner] of skipped) {
    // No framework, so only the skip list decides.
    assert.deepEqual(pickDevScript(pkg({ scripts }), undefined), { script: undefined, hadDevScript: true, skippedRunner: runner }, JSON.stringify(scripts));
  }
  // Member flags count only next to a package manager: other tools use -w for watch.
  for (const dev of ["tsc -w", "nodemon -w src server.js"]) {
    assert.equal(pickDevScript(pkg({ scripts: { dev } }), undefined).skippedRunner, false, dev);
  }
  assert.equal(classifyPackage(pkg({ deps: { react: "^19.0.0" }, scripts: { dev: "tsc -w" } }), NO_MARKERS).reason, "no-web-framework");
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

// ---- package managers (R5) ----

function signals(input: {
  field?: unknown;
  files?: string[];
  markers?: string[];
  pnpmWorkspaceFile?: boolean;
  denoMarker?: boolean;
  yarnrc?: boolean;
  pnp?: boolean;
  lockHead?: string | null;
  levelsUp?: number;
}): PackageManagerSignals {
  return {
    field: parsePackageManagerField(input.field),
    lockfiles: lockfileManagers(input.files ?? []),
    installedMarkers: installedMarkerManagers(input.markers ?? []),
    pnpmWorkspaceFile: input.pnpmWorkspaceFile ?? false,
    denoMarker: input.denoMarker ?? false,
    yarnFlavourHints: { yarnrc: input.yarnrc ?? false, pnp: input.pnp ?? false, lockHead: input.lockHead ?? null },
    levelsUp: input.levelsUp ?? 0,
  };
}

test("each lockfile name maps to its manager, and two files of one manager are not a conflict", () => {
  assert.deepEqual([...lockfileManagers(["pnpm-lock.yaml"])], [["pnpm", "pnpm-lock.yaml"]]);
  assert.deepEqual([...lockfileManagers(["yarn.lock"])], [["yarn", "yarn.lock"]]);
  assert.deepEqual([...lockfileManagers(["bun.lockb"])], [["bun", "bun.lockb"]]);
  assert.deepEqual([...lockfileManagers(["package-lock.json"])], [["npm", "package-lock.json"]]);
  assert.deepEqual([...lockfileManagers(["npm-shrinkwrap.json"])], [["npm", "npm-shrinkwrap.json"]]);
  assert.deepEqual([...lockfileManagers(["README.md", "deno.lock", "package.json"])], []);
  for (const files of [["bun.lock", "bun.lockb"], ["package-lock.json", "npm-shrinkwrap.json"]]) {
    const info = decidePackageManager(signals({ files }));
    assert.ok(info.name !== null, files.join(" + "));
    assert.equal(info.conflict, undefined);
  }
});

test("the packageManager field decides when there's no lockfile or only its own", () => {
  assert.deepEqual(decidePackageManager(signals({ field: "pnpm@9.15.0+sha512.abc" })), {
    name: "pnpm",
    source: "packageManager",
    lockfileLevelsUp: 0,
  });
  assert.deepEqual(decidePackageManager(signals({ field: "pnpm@9.15.0+sha512.abc", files: ["pnpm-lock.yaml"] })), {
    name: "pnpm",
    source: "packageManager",
    lockfile: "pnpm-lock.yaml",
    lockfileLevelsUp: 0,
  });
});

test("a packageManager field that disagrees with the lockfile is a conflict naming both", () => {
  assert.deepEqual(decidePackageManager(signals({ field: "pnpm@9.15.0", files: ["package-lock.json"] })), {
    name: null,
    source: "packageManager",
    lockfileLevelsUp: 0,
    conflict: ["npm", "pnpm"],
    field: "pnpm",
  });
  // The field's manager is named only when the field is part of the conflict.
  assert.equal(decidePackageManager(signals({ files: ["yarn.lock", "package-lock.json"] })).field, undefined);
});

test("an unknown or malformed packageManager field is ignored", () => {
  assert.equal(parsePackageManagerField("deno@2"), null);
  assert.equal(parsePackageManagerField(42), null);
  assert.equal(parsePackageManagerField(""), null);
  assert.deepEqual(parsePackageManagerField("pnpm"), { name: "pnpm" });
  assert.deepEqual(parsePackageManagerField("yarn@4.5.0"), { name: "yarn", major: 4 });
  // A known manager followed by anything but a version is not a declaration.
  for (const malformed of [
    "pnpm@junk",
    "pnpm@",
    "yarn!",
    "npm@11.x",
    "bun 1.2.0",
    "pnpmx",
    "pnpm@9.0.0 extra",
    // Not an exact semver version: empty identifiers, leading zeros, missing parts.
    "pnpm@9.0.0-alpha..1",
    "pnpm@9.0.0-",
    "pnpm@9.0.0-.alpha",
    "pnpm@9.0.0-alpha.",
    "pnpm@9.0.0-01",
    "npm@11.0.0+",
    "npm@11.0.0+sha512..ab",
    "npm@11.0.0+sha512-ab==x",
    "pnpm@09.0.0",
    "pnpm@9",
    "pnpm@9.0",
  ]) {
    assert.equal(parsePackageManagerField(malformed), null, malformed);
  }
  assert.deepEqual(parsePackageManagerField("npm@11.11.0+sha512.3f1c0e9a8b"), { name: "npm", major: 11 });
  assert.deepEqual(parsePackageManagerField("pnpm@10.0.0-rc.1"), { name: "pnpm", major: 10 });
  assert.deepEqual(parsePackageManagerField("yarn@4.0.0-rc.0.x-1+sha224.9f"), { name: "yarn", major: 4 });
  // Corepack's SRI-style pin carries base64 `/`, `+` and `=`.
  assert.deepEqual(parsePackageManagerField("pnpm@10.5.2+sha512-82gRxKrh/eY5U+nNorkTF/cw=="), { name: "pnpm", major: 10 });
  assert.deepEqual(parsePackageManagerField("yarn@4.6.0+sha224.953c8233f7a92884eee2de69a1b92d1f2ec1655e66d08071ba9a02fa"), {
    name: "yarn",
    major: 4,
  });
  assert.equal(decidePackageManager(signals({ field: "pnpm@9.0.0-alpha..1", files: [] })).name, "npm");
  assert.equal(decidePackageManager(signals({ field: "pnpm@junk", files: [] })).name, "npm");
  assert.equal(decidePackageManager(signals({ field: "deno@2", files: ["yarn.lock"] })).name, "yarn");
});

test("this repository's own Corepack-pinned packageManager is a declaration", () => {
  const field = (JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as { packageManager: string })
    .packageManager;
  assert.match(field, /\+sha512-/u);
  assert.equal(parsePackageManagerField(field)?.name, "npm");
});

test("one manager's lockfile decides the manager", () => {
  assert.deepEqual(decidePackageManager(signals({ files: ["bun.lock"] })), {
    name: "bun",
    source: "lockfile",
    lockfile: "bun.lock",
    lockfileLevelsUp: 0,
  });
});

test("lockfiles of two managers give no manager and list the conflict", () => {
  assert.deepEqual(decidePackageManager(signals({ files: ["yarn.lock", "package-lock.json"] })), {
    name: null,
    source: "lockfile",
    lockfileLevelsUp: 0,
    conflict: ["npm", "yarn"],
  });
});

test("a conflict with exactly one manager's install marker picks it and keeps the conflict", () => {
  const files = ["package-lock.json", "yarn.lock"];
  assert.deepEqual(decidePackageManager(signals({ files, markers: [".yarn-integrity"], lockHead: "# yarn lockfile v1\n" })), {
    name: "yarn",
    source: "installed",
    lockfile: "yarn.lock",
    lockfileLevelsUp: 0,
    conflict: ["npm", "yarn"],
    yarn: "classic",
  });
  assert.equal(decidePackageManager(signals({ files, markers: [".package-lock.json", ".yarn-integrity"] })).name, null);
  // A marker of a manager outside the conflict settles nothing.
  assert.equal(decidePackageManager(signals({ files, markers: [".modules.yaml"] })).name, null);
});

test("pnpm-workspace.yaml without a lockfile means pnpm", () => {
  assert.deepEqual(decidePackageManager(signals({ pnpmWorkspaceFile: true })), {
    name: "pnpm",
    source: "workspace-file",
    lockfileLevelsUp: 0,
  });
});

test("a Deno project without an npm-family lockfile has no manager and is marked unsupported", () => {
  assert.deepEqual(decidePackageManager(signals({ denoMarker: true })), {
    name: null,
    source: "none",
    lockfileLevelsUp: 0,
    unsupported: "deno",
  });
  assert.equal(decidePackageManager(signals({ denoMarker: true, files: ["package-lock.json"] })).name, "npm");
});

test("no signal means npm with source none and lockfileLevelsUp 0", () => {
  assert.deepEqual(decidePackageManager(signals({})), { name: "npm", source: "none", lockfileLevelsUp: 0 });
});

test("an enclosing signal sets source enclosing and lockfileLevelsUp", () => {
  assert.deepEqual(decidePackageManager(signals({ files: ["pnpm-lock.yaml"], levelsUp: 2 })), {
    name: "pnpm",
    source: "enclosing",
    lockfile: "pnpm-lock.yaml",
    lockfileLevelsUp: 2,
  });
  assert.deepEqual(decidePackageManager(signals({ pnpmWorkspaceFile: true, levelsUp: 1 })), {
    name: "pnpm",
    source: "enclosing",
    lockfileLevelsUp: 1,
  });
});

test("the yarn flavour follows the field's major version, then .yarnrc.yml, .pnp.cjs or a non-v1 yarn.lock head", () => {
  const flavour = (input: Parameters<typeof signals>[0]) => decidePackageManager(signals({ files: ["yarn.lock"], ...input })).yarn;
  assert.equal(flavour({ field: "yarn@1.22.22", yarnrc: true }), "classic");
  assert.equal(flavour({ field: "yarn@4.5.0" }), "berry");
  assert.equal(flavour({ yarnrc: true }), "berry");
  assert.equal(flavour({ pnp: true }), "berry");
  assert.equal(flavour({ lockHead: "# This file is generated by running \"yarn install\"\n\n__metadata:\n  version: 8\n" }), "berry");
  assert.equal(flavour({ lockHead: "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n" }), "classic");
  assert.equal(flavour({ lockHead: "" }), "classic");
  assert.equal(decidePackageManager(signals({ files: ["pnpm-lock.yaml"] })).yarn, undefined);
});

// ---- commands (R10) ----

function info(name: PackageManagerInfo["name"], extra: Partial<PackageManagerInfo> = {}): PackageManagerInfo {
  return { name, source: "lockfile", lockfileLevelsUp: 0, ...extra };
}

test("installCommand gives the frozen install with a lockfile and a plain install without one", () => {
  const rows: Array<[PackageManagerInfo, string, string[]]> = [
    [info("npm", { lockfile: "package-lock.json" }), "npm", ["ci"]],
    [info("npm", { lockfile: "npm-shrinkwrap.json" }), "npm", ["ci"]],
    [info("npm", { source: "none" }), "npm", ["install"]],
    [info("pnpm", { lockfile: "pnpm-lock.yaml" }), "pnpm", ["install", "--frozen-lockfile"]],
    [info("pnpm", { source: "packageManager" }), "pnpm", ["install"]],
    [info("pnpm", { source: "workspace-file" }), "pnpm", ["install"]],
    [info("yarn", { lockfile: "yarn.lock", yarn: "classic" }), "yarn", ["install", "--frozen-lockfile"]],
    [info("yarn", { lockfile: "yarn.lock", yarn: "berry" }), "yarn", ["install", "--immutable"]],
    [info("yarn", { source: "packageManager", yarn: "berry" }), "yarn", ["install"]],
    [info("bun", { lockfile: "bun.lock" }), "bun", ["install", "--frozen-lockfile"]],
    [info("bun", { source: "packageManager" }), "bun", ["install"]],
    [info("pnpm", { source: "enclosing", lockfile: "pnpm-lock.yaml", lockfileLevelsUp: 2 }), "pnpm", ["install", "--frozen-lockfile"]],
  ];
  for (const [input, command, args] of rows) {
    assert.deepEqual(installCommand(input), { command, args }, JSON.stringify(input));
  }
  assert.throws(() => installCommand(info(null, { conflict: ["npm", "yarn"] })));
});

test("runScriptCommand passes extra arguments the way each manager expects", () => {
  const extra = ["--port", "5173"];
  assert.deepEqual(runScriptCommand(info("npm"), "dev", extra), { command: "npm", args: ["run", "dev", "--", "--port", "5173"] });
  // pnpm and Yarn 2+ pass a bare -- through to the script, so they get none.
  assert.deepEqual(runScriptCommand(info("pnpm"), "dev", extra), { command: "pnpm", args: ["run", "dev", "--port", "5173"] });
  assert.deepEqual(runScriptCommand(info("yarn", { yarn: "classic" }), "dev", extra), { command: "yarn", args: ["run", "dev", "--port", "5173"] });
  assert.deepEqual(runScriptCommand(info("yarn", { yarn: "berry" }), "dev", extra), { command: "yarn", args: ["run", "dev", "--port", "5173"] });
  assert.deepEqual(runScriptCommand(info("bun"), "dev", extra), { command: "bun", args: ["run", "dev", "--port", "5173"] });
  assert.deepEqual(runScriptCommand(info("npm"), "start"), { command: "npm", args: ["run", "start"] });
  assert.deepEqual(runScriptCommand(info("npm"), "start", []), { command: "npm", args: ["run", "start"] });
});

test("runScriptCommand refuses an unsafe name, a null manager, or an extra argument with a control character", () => {
  assert.throws(() => runScriptCommand(info("npm"), "--prefix"));
  assert.throws(() => runScriptCommand(info("npm"), "dev\nrm"));
  assert.throws(() => runScriptCommand(info("npm"), ""));
  assert.throws(() => runScriptCommand(info(null, { unsupported: "deno" }), "dev"));
  assert.throws(() => runScriptCommand(info("pnpm"), "dev", ["--port", "5173\n"]));
});

// ---- workspace patterns (R1) ----

test("workspacePatterns reads package.json workspaces in both shapes and pnpm-workspace.yaml packages, splits out ! patterns, and drops absolute and .. patterns", () => {
  assert.deepEqual(workspacePatterns({ workspaces: ["apps/*", "./packages/*", "!packages/legacy", "/etc", "../outside", "apps/../..", 42] }, null), {
    include: ["apps/*", "packages/*"],
    exclude: ["packages/legacy"],
  });
  assert.deepEqual(workspacePatterns({ workspaces: { packages: ["apps/*"], nohoist: ["**/x"] } }, null), { include: ["apps/*"], exclude: [] });
  assert.deepEqual(workspacePatterns(null, { packages: ["apps/*", "packages/**", "!**/test/**"] }), {
    include: ["apps/*", "packages/**"],
    exclude: ["**/test/**"],
  });
  assert.deepEqual(workspacePatterns({ workspaces: ["apps/*"] }, { packages: ["apps/*", "tools/web"] }), {
    include: ["apps/*", "tools/web"],
    exclude: [],
  });
  assert.deepEqual(workspacePatterns({ workspaces: "apps/*" }, ["apps/*"]), { include: [], exclude: [] });
});

test("matchesWorkspacePattern handles exact paths, one-level stars, a star inside a segment and ** as one level, and ignores braces", () => {
  const yes: Array<[string, string]> = [
    ["web", "web"],
    ["apps/web", "apps/web"],
    ["apps/group/web", "apps/group/web"],
    ["apps/web", "apps/*"],
    ["apps/group/web", "apps/group/*"],
    ["apps/admin-app", "apps/*-app"],
    ["packages/ui", "packages/**"],
  ];
  const no: Array<[string, string]> = [
    ["apps/group/web", "apps/*"],
    ["apps/admin", "apps/*-app"],
    ["apps/web", "apps/{web,docs}"],
    ["a/b/c/d", "a/b/c/d"],
    ["apps/web", "*/web"],
    ["apps", "apps/*"],
  ];
  for (const [rel, pattern] of yes) assert.equal(matchesWorkspacePattern(rel, pattern), true, `${rel} ~ ${pattern}`);
  for (const [rel, pattern] of no) assert.equal(matchesWorkspacePattern(rel, pattern), false, `${rel} !~ ${pattern}`);
});

// ---- design target (R8) ----

function detected(root: string, kind: DetectedApp["kind"], reason: DetectedApp["reason"]): DetectedApp {
  return {
    root,
    kind,
    reason,
    scripts: [],
    usesReact: kind === "react-nonweb",
    packageManager: { name: "npm", source: "none", lockfileLevelsUp: 0 },
    installRoot: ".",
    installed: false,
  };
}

test("designTarget gives single, choose, react-nonweb or none", () => {
  const web = detected("apps/web", "web", "ok");
  const docs = detected("apps/docs", "web", "ok");
  const ui = detected("packages/ui", "react-nonweb", "no-web-framework");
  const root = detected(".", "none", "workspace-runner");
  const custom = detected("tools/server", "none", "unknown-framework");

  // A React package beside one web app doesn't change the target.
  assert.deepEqual(designTarget({ apps: [root, web, ui], truncated: false }), { kind: "single", app: web });
  assert.deepEqual(designTarget({ apps: [root, docs, web, ui], truncated: false }), { kind: "choose", apps: [docs, web] });
  assert.deepEqual(designTarget({ apps: [root, ui], truncated: false }), { kind: "react-nonweb", apps: [ui] });
  // Every candidate stays visible, so 2c and 3d can tell a workspace runner from an unknown framework.
  assert.deepEqual(designTarget({ apps: [root, custom], truncated: false }), { kind: "none", apps: [root, custom] });
  assert.deepEqual(designTarget({ apps: [], truncated: false }), { kind: "none", apps: [] });
  // A web app with no manager is still web: refusing it is 2b's job.
  const conflicted = { ...web, packageManager: { name: null, source: "lockfile" as const, lockfileLevelsUp: 0, conflict: ["npm" as const, "yarn" as const] } };
  assert.deepEqual(designTarget({ apps: [conflicted], truncated: false }), { kind: "single", app: conflicted });
});

test("a workspace root counts as web only when its script runs the framework's own dev command", () => {
  const root = (dev: string) => pkg({ deps: { react: "^19.0.0" }, devDeps: { vite: "^6.0.0" }, scripts: { dev } });
  const atRoot = { workspaceRunnerFile: false, workspaceRoot: true };
  assert.equal(classifyPackage(root("vite"), atRoot).kind, "web");
  // A script that only reaches the app some other way hands off to a member.
  assert.deepEqual(
    [classifyPackage(root("node scripts/dev.js"), atRoot).kind, classifyPackage(root("node scripts/dev.js"), atRoot).reason],
    ["none", "workspace-runner"],
  );
  // The same script in a package that isn't a workspace root is still its app's dev script.
  assert.equal(classifyPackage(root("node scripts/dev.js"), NO_MARKERS).kind, "web");
});

test("a framework app whose only scripts are production runs is no-dev-script, not React mocks", () => {
  for (const scripts of [{ start: "next start" }, { start: "next build && next start", build: "next build" }]) {
    const result = classifyPackage(pkg({ deps: { next: "15.0.0", react: "^19.0.0" }, scripts }), NO_MARKERS);
    assert.deepEqual([result.kind, result.reason], ["none", "no-dev-script"], JSON.stringify(scripts));
  }
  // A build-only library still goes to React mocks.
  const library = classifyPackage(pkg({ devDeps: { react: "^19.0.0", vite: "^6.0.0" }, scripts: { dev: "vite build --watch" } }), NO_MARKERS);
  assert.equal(library.reason, "no-web-framework");
  // So does a production run next to a Storybook.
  const stories = classifyPackage(
    pkg({ devDeps: { react: "^19.0.0", vite: "^6.0.0", storybook: "^8.0.0" }, scripts: { start: "vite preview" } }),
    NO_MARKERS,
  );
  assert.equal(stories.reason, "no-web-framework");
});
