import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  exposedSockets,
  installOnlyAddedLockfile,
  isAddressInUse,
  lastLines,
  launchFingerprint,
  launchFingerprintInput,
  launchPlan,
  missingModuleHint,
  needsInstall,
  providerKeyNames,
  readyPort,
  runsFrameworkCli,
  type LaunchSurface,
} from "./app-launch-core.js";
import type { DetectedApp, FrameworkId, PackageManagerName } from "./app-server-core.js";

function app(framework: FrameworkId | undefined, manager: PackageManagerName = "npm", script = "dev"): DetectedApp {
  return {
    root: ".",
    kind: "web",
    reason: "ok",
    ...(framework ? { framework } : {}),
    script,
    scripts: [script],
    usesReact: true,
    packageManager: { name: manager, source: "lockfile", lockfileLevelsUp: 0 },
    installRoot: ".",
    installed: true,
  };
}

const BIN = { node: "/opt/node/bin/node", manager: "/opt/pm/bin/pnpm" };
const plan = (detected: DetectedApp, scriptText: string, env: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) =>
  launchPlan(detected, { [detected.script!]: scriptText }, 5173, env, { binDirs: [path.dirname(BIN.node), path.dirname(BIN.manager)], providerKeys: [], platform: "linux" });

test("a Vite script gets --host 127.0.0.1 --port --strictPort, after -- for npm and bare for pnpm", () => {
  const npm = plan(app("vite", "npm"), "vite");
  assert.deepEqual(npm.extraArgs, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  assert.deepEqual(npm.run.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  const pnpm = plan(app("vite", "pnpm"), "vite dev");
  assert.deepEqual(pnpm.run.args, ["run", "dev", "--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  assert.equal(pnpm.env.HOST, undefined);
  assert.equal(pnpm.env.PORT, undefined);
  for (const framework of ["tanstack-router", "tanstack-start"] as const) {
    assert.deepEqual(plan(app(framework), "vite").extraArgs, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"], framework);
  }
});

test("react-router dev and remix vite:dev get --strictPort; astro, nuxt, angular and vinxi do not", () => {
  assert.deepEqual(plan(app("react-router"), "react-router dev").extraArgs, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  assert.deepEqual(plan(app("remix"), "remix vite:dev").extraArgs, ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);
  for (const [framework, script] of [
    ["astro", "astro dev"],
    ["nuxt", "nuxt dev"],
    ["nuxt", "nuxi dev"],
    ["angular", "ng serve"],
    ["tanstack-start", "vinxi dev"],
  ] as const) {
    assert.deepEqual(plan(app(framework), script).extraArgs, ["--host", "127.0.0.1", "--port", "5173"], script);
  }
});

test("Next gets --hostname and PORT; Gatsby gets -H and -p", () => {
  const next = plan(app("next"), "next dev --turbopack");
  assert.deepEqual(next.extraArgs, ["--hostname", "127.0.0.1", "--port", "5173"]);
  assert.equal(next.env.PORT, "5173");
  assert.equal(next.env.HOST, undefined);
  const gatsby = plan(app("gatsby"), "gatsby develop");
  assert.deepEqual(gatsby.extraArgs, ["-H", "127.0.0.1", "-p", "5173"]);
});

test("classic remix dev, CRA and Remix 3 get HOST and PORT only", () => {
  for (const [framework, script] of [
    ["remix", "remix dev"],
    ["create-react-app", "react-scripts start"],
    ["remix-3", "node --watch --import remix/node-tsx server.ts"],
  ] as const) {
    const result = plan(app(framework), script);
    assert.deepEqual(result.extraArgs, [], script);
    assert.equal(result.env.HOST, "127.0.0.1", script);
    assert.equal(result.env.PORT, "5173", script);
  }
});

test("a custom server script gets HOST and PORT and no flags", () => {
  const result = plan(app("vite"), "node server.mjs");
  assert.equal(runsFrameworkCli("node server.mjs", "vite"), undefined);
  assert.deepEqual(result.extraArgs, []);
  assert.deepEqual(result.run.args, ["run", "dev"]);
  assert.equal(result.env.HOST, "127.0.0.1");
  assert.equal(result.env.PORT, "5173");
});

test("a script that sets its own port keeps it and gets only the host", () => {
  assert.deepEqual(plan(app("vite"), "vite --port 3000").extraArgs, ["--host", "127.0.0.1"]);
  assert.deepEqual(plan(app("vite"), "vite --port=3000").extraArgs, ["--host", "127.0.0.1"]);
  assert.deepEqual(plan(app("gatsby"), "gatsby develop -p 8001").extraArgs, ["-H", "127.0.0.1"]);
  assert.deepEqual(plan(app("vite"), "vite --strictPort").extraArgs, ["--host", "127.0.0.1"]);
});

test("a script with its own --host gets no host flag", () => {
  assert.deepEqual(plan(app("vite"), "vite --host").extraArgs, ["--port", "5173", "--strictPort"]);
  assert.deepEqual(plan(app("next"), "next dev -H 0.0.0.0").extraArgs, ["--port", "5173"]);
  assert.deepEqual(plan(app("next"), "next dev --hostname=0.0.0.0").extraArgs, ["--port", "5173"]);
});

test("the environment scrub", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    AIDEN_ANALYTICS: "0",
    AIDEN_FOO: "1",
    npm_lifecycle_event: "x",
    npm_package_name: "aiden",
    NPM_CONFIG_REGISTRY: "https://registry.example",
    npm_config_cache: "/tmp/cache",
    INIT_CWD: "/x",
    OPENAI_API_KEY: "k",
    ANTHROPIC_API_KEY: "k",
    NPM_TOKEN: "t",
    GH_TOKEN: "g",
    PATH: ":/usr/bin::",
  };
  const fakeFind = (provider: string, source: Record<string, string | undefined>) =>
    ({ openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] })[provider]?.filter((name) => source[name] !== undefined);
  const keys = providerKeyNames(env, ["openai", "anthropic", "nobody"], fakeFind);
  assert.deepEqual([...keys].sort(), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  const result = launchPlan(app("vite"), { dev: "vite" }, 5173, env, { binDirs: ["/opt/node/bin"], providerKeys: keys, platform: "linux" });
  for (const name of [
    "NODE_ENV",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "AIDEN_ANALYTICS",
    "AIDEN_FOO",
    "npm_lifecycle_event",
    "npm_package_name",
    "NPM_CONFIG_REGISTRY",
    "npm_config_cache",
    "INIT_CWD",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    assert.equal(name in result.env, false, name);
  }
  assert.equal(result.env.NPM_TOKEN, "t");
  assert.equal(result.env.GH_TOKEN, "g");
  assert.equal(result.env.PATH, "/opt/node/bin:/usr/bin");
  assert.equal(result.env.BROWSER, "none");
  assert.equal(result.env.FORCE_COLOR, "0");
  assert.equal(result.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");
  assert.equal(env.NODE_ENV, "production", "the input is not changed");
});

test("the Bedrock bearer token is scrubbed even when pi-ai's key list doesn't name it", () => {
  const env = { AWS_BEARER_TOKEN_BEDROCK: "secret", AWS_PROFILE: "dev", PATH: "/usr/bin" };
  const keys = providerKeyNames(env, ["amazon-bedrock"], () => []);
  const result = launchPlan(app("vite"), { dev: "vite" }, 5173, env, { binDirs: [], providerKeys: keys, platform: "linux" });
  assert.equal(result.env.AWS_BEARER_TOKEN_BEDROCK, undefined);
  assert.equal(result.env.AWS_PROFILE, "dev", "tooling configuration stays");
  assert.equal(providerKeyNames({ PATH: "/usr/bin" }, [], () => []).has("AWS_BEARER_TOKEN_BEDROCK"), false, "only a set variable is named");
});

test("telemetry variables are set unless the person set them", () => {
  const result = plan(app("next"), "next dev", { PATH: "/usr/bin", NEXT_TELEMETRY_DISABLED: "0" });
  assert.equal(result.env.NEXT_TELEMETRY_DISABLED, "0");
  for (const [name, value] of [
    ["ASTRO_TELEMETRY_DISABLED", "1"],
    ["NUXT_TELEMETRY_DISABLED", "1"],
    ["GATSBY_TELEMETRY_DISABLED", "1"],
    ["NG_CLI_ANALYTICS", "false"],
    ["DO_NOT_TRACK", "1"],
  ]) {
    assert.equal(result.env[name], value, name);
  }
  assert.equal(plan(app("next"), "next dev").env.NEXT_TELEMETRY_DISABLED, "1");
});

test("the bin folders of Node and the manager come first on PATH", () => {
  const result = plan(app("vite"), "vite", { PATH: "/usr/bin:/bin" });
  assert.deepEqual(result.env.PATH!.split(":"), ["/opt/node/bin", "/opt/pm/bin", "/usr/bin", "/bin"]);
});

test("readiness: a printed port that the job owns wins", () => {
  assert.equal(readyPort({ owned: [5173, 5174], printed: [5174], planned: 5173 }), 5174);
});

test("readiness: a printed port the job doesn't own is ignored", () => {
  assert.equal(readyPort({ owned: [5173], printed: [3000], planned: 5173 }), 5173);
  assert.equal(readyPort({ owned: [], printed: [3000], planned: 3000 }), undefined);
});

test("readiness: with no printed URL, the planned port or the only owned port is ready", () => {
  assert.equal(readyPort({ owned: [4000, 5173], printed: [], planned: 5173 }), 5173);
  assert.equal(readyPort({ owned: [4000], printed: [], planned: 5173 }), 4000);
});

test("readiness: two owned ports and no match is not ready yet", () => {
  assert.equal(readyPort({ owned: [4000, 4001], printed: [], planned: 5173 }), undefined);
});

test("readiness: 9229 and 24678 never count", () => {
  assert.equal(readyPort({ owned: [9229, 24678], printed: [9229], planned: 9229 }), undefined);
  assert.equal(readyPort({ owned: [9229, 24678, 4000], printed: [], planned: 5173 }), 4000);
});

test("readiness: nothing owned is never ready", () => {
  assert.equal(readyPort({ owned: [], printed: [], planned: 5173 }), undefined);
});

test("exposure: wildcard and LAN sockets are exposed; loopback ones are not", () => {
  const sockets = [
    { pid: 1, address: "127.0.0.1", port: 1 },
    { pid: 1, address: "127.0.0.2", port: 2 },
    { pid: 1, address: "::1", port: 3 },
    { pid: 1, address: "::ffff:127.0.0.1", port: 4 },
    { pid: 2, address: "*", port: 5 },
    { pid: 2, address: "0.0.0.0", port: 6 },
    { pid: 2, address: "::", port: 7 },
    { pid: 2, address: "192.168.1.10", port: 8 },
  ];
  assert.deepEqual(exposedSockets(sockets).map((socket) => socket.port), [5, 6, 7, 8]);
  assert.deepEqual(exposedSockets(sockets.slice(0, 4)), []);
});

const install = (overrides: Partial<Parameters<typeof needsInstall>[0]> = {}) =>
  needsInstall({ installed: true, lockfileLevelsUp: 0, record: undefined, lockHash: "L1", manager: "npm", forced: false, ...overrides });

test("install decision, row by row", () => {
  assert.equal(install({ installed: false }), "install", "no node_modules");
  assert.equal(install({ record: { state: "started", manager: "npm", lockHash: "L1" } }), "install", "Aiden's install did not finish");
  assert.equal(install({ record: { state: "done", manager: "npm", lockHash: "L0" } }), "install", "the lockfile changed");
  assert.equal(install({ record: { state: "done", manager: "pnpm", lockHash: "L1" } }), "install", "the manager changed");
  assert.equal(install({ forced: true, record: { state: "done", manager: "npm", lockHash: "L1" } }), "install", "asked for");
  assert.equal(install({ record: { state: "done", manager: "npm", lockHash: "L1" } }), "skip", "Aiden's install is current");
});

test("node_modules present and no record is skip", () => {
  assert.equal(install(), "skip");
});

test("lockfileLevelsUp 1 with node_modules is skip, without it is outside-workspace, and a forced install is always outside-workspace", () => {
  assert.equal(install({ lockfileLevelsUp: 1 }), "skip");
  assert.equal(install({ lockfileLevelsUp: 1, forced: true }), "outside-workspace", "an asked-for install never silently skips");
  assert.equal(install({ lockfileLevelsUp: 2, installed: false }), "outside-workspace");
  assert.equal(install({ lockfileLevelsUp: 1, installed: false, forced: true }), "outside-workspace");
});

function surface(overrides: Partial<LaunchSurface> = {}): LaunchSurface {
  return {
    appRoot: "apps/web",
    installRoot: ".",
    lockfileLevelsUp: 0,
    manager: "pnpm",
    script: "dev",
    scripts: { "app:dev": "vite", "app:predev": null, "app:postdev": null, "install:postinstall": "node setup.js" },
    packageManager: { app: undefined, install: "pnpm@9.15.0" },
    devEngines: { app: undefined, install: { runtime: { name: "node" } } },
    installArgv: ["pnpm", "install", "--frozen-lockfile"],
    runArgv: ["pnpm", "run", "dev"],
    files: [
      ["pnpm-lock.yaml", "aa"],
      ["apps/web/.npmrc", "bb"],
      ["apps/web/vite.config.ts", "cc"],
    ],
    ...overrides,
  };
}

test("the fingerprint changes when any listed script text, packageManager, devEngines, rc, workspace or config file, the yarnPath target or the lockfile changes", () => {
  const base = launchFingerprint(surface());
  const changes: Array<[string, Partial<LaunchSurface>]> = [
    ["script", { scripts: { ...surface().scripts, "app:dev": "vite --host" } }],
    ["pre script appears", { scripts: { ...surface().scripts, "app:predev": "curl x" } }],
    ["install script", { scripts: { ...surface().scripts, "install:postinstall": "node other.js" } }],
    ["packageManager", { packageManager: { app: undefined, install: "pnpm@9.15.1" } }],
    ["devEngines", { devEngines: { app: undefined, install: { runtime: { name: "bun" } } } }],
    ["lockfile", { files: [["pnpm-lock.yaml", "ab"], ["apps/web/.npmrc", "bb"], ["apps/web/vite.config.ts", "cc"]] }],
    ["rc", { files: [["pnpm-lock.yaml", "aa"], ["apps/web/.npmrc", "bc"], ["apps/web/vite.config.ts", "cc"]] }],
    ["config", { files: [["pnpm-lock.yaml", "aa"], ["apps/web/.npmrc", "bb"], ["apps/web/vite.config.ts", "cd"]] }],
    ["workspace file appears", { files: [...surface().files, ["pnpm-workspace.yaml", "dd"]] }],
    ["yarnPath target", { files: [...surface().files, [".yarn/releases/yarn-4.cjs", "ee"]] }],
    ["script name", { script: "start" }],
    ["install argv", { installArgv: ["pnpm", "install"] }],
    ["manager", { manager: "npm" }],
  ];
  for (const [what, change] of changes) assert.notEqual(launchFingerprint(surface(change)), base, what);
});

test("an install that only wrote the install root's lockfile is recognised; any other change is not", () => {
  const before = surface({ installArgv: ["pnpm", "install"], files: [["apps/web/.npmrc", "bb"], ["apps/web/vite.config.ts", "cc"]] });
  assert.equal(installOnlyAddedLockfile(before, surface()), true, "pnpm-lock.yaml and the frozen install argv");
  const nested = { appRoot: "apps/web", installRoot: "apps/web", manager: "npm" as const };
  assert.equal(
    installOnlyAddedLockfile(
      surface({ ...nested, installArgv: ["npm", "install"], files: [] }),
      surface({ ...nested, installArgv: ["npm", "ci"], files: [["apps/web/package-lock.json", "ab"]] }),
    ),
    true,
    "a lockfile in a nested install root",
  );
  const frozen = { installArgv: ["pnpm", "install", "--frozen-lockfile"] };
  const not: Array<[string, Partial<LaunchSurface>]> = [
    ["nothing added", { ...frozen, files: before.files }],
    ["the lockfile and a changed rc", { files: [["pnpm-lock.yaml", "aa"], ["apps/web/.npmrc", "bx"], ["apps/web/vite.config.ts", "cc"]] }],
    ["the lockfile and a new file", { files: [...surface().files, ["pnpm-workspace.yaml", "dd"]] }],
    ["a file that isn't a lockfile", { files: [...before.files, ["evil.config.js", "ee"]] }],
    ["a lockfile in another folder", { files: [...before.files, ["apps/web/pnpm-lock.yaml", "aa"]] }],
    ["a lockfile that is missing", { files: [...before.files, ["pnpm-lock.yaml", "missing"]] }],
    ["a removed file", { files: [["pnpm-lock.yaml", "aa"], ["apps/web/vite.config.ts", "cc"]] }],
    ["a changed script", { scripts: { ...surface().scripts, "app:dev": "vite && curl x" } }],
    ["a changed packageManager field", { packageManager: { app: undefined, install: "pnpm@10.0.0" } }],
    ["another manager", { manager: "npm", installArgv: ["npm", "ci"] }],
    ["a lockfile above the workspace", { lockfileLevelsUp: 1 }],
  ];
  for (const [what, change] of not) assert.equal(installOnlyAddedLockfile(before, surface(change)), false, what);
  assert.equal(installOnlyAddedLockfile({ ...before, installArgv: null }, surface()), false, "no install argv before");
});

test("the fingerprint does not change with the port, the Node path or the manager path", () => {
  // None of them is part of the surface: the run argv is the manager's name and the script, nothing else.
  const input = launchFingerprintInput(surface());
  const text = JSON.stringify(input);
  assert.equal(text.includes("5173"), false);
  assert.equal(text.includes("/opt/"), false);
  assert.equal(launchFingerprint(surface()), launchFingerprint(surface()));
});

test("file order doesn't matter, and a missing file differs from an empty one", () => {
  const files = surface().files;
  assert.equal(launchFingerprint(surface({ files: [...files].reverse() })), launchFingerprint(surface()));
  const objectOrder = launchFingerprint(surface({ devEngines: { app: undefined, install: { runtime: { name: "node", version: "22" } } } }));
  assert.equal(objectOrder, launchFingerprint(surface({ devEngines: { app: undefined, install: { runtime: { version: "22", name: "node" } } } })));
  const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  assert.notEqual(
    launchFingerprint(surface({ files: [...files, [".yarnrc.yml", "missing"]] })),
    launchFingerprint(surface({ files: [...files, [".yarnrc.yml", EMPTY_SHA]] })),
  );
  assert.notEqual(
    launchFingerprint(surface({ scripts: { ...surface().scripts, "app:predev": "" } })),
    launchFingerprint(surface()),
    "an empty script differs from no script",
  );
});

test("isAddressInUse matches Node's EADDRINUSE, Vite's \"is already in use\" and CRA's \"Something is already running on port\"", () => {
  assert.equal(isAddressInUse("Error: listen EADDRINUSE: address already in use 127.0.0.1:5173"), true);
  assert.equal(isAddressInUse("error when starting dev server:\nError: Port 5173 is already in use"), true);
  assert.equal(isAddressInUse("Something is already running on port 3000."), true);
  assert.equal(isAddressInUse("Compiled successfully"), false);
});

test("missingModuleHint finds Node, Vite and webpack missing-module lines", () => {
  for (const tail of [
    "Error: Cannot find module 'react'",
    "code: 'ERR_MODULE_NOT_FOUND'",
    "Module not found: Error: Can't resolve 'lodash'",
    '[vite] Internal server error: Failed to resolve import "react-dom/client"',
  ]) {
    assert.match(missingModuleHint(tail) ?? "", /restart with install: true/u, tail);
  }
  assert.equal(missingModuleHint("TypeError: x is not a function"), undefined);
});

test("lastLines keeps the last N lines within the character cap", () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n") + "\n";
  assert.equal(lastLines(text, 3, 1000), "line 27\nline 28\nline 29");
  assert.equal(lastLines(text, 20, 12), "e 28\nline 29".slice(-12));
  assert.ok(lastLines("x".repeat(5000), 20, 2000).length <= 2000);
  assert.equal(lastLines("", 20, 2000), "");
});
