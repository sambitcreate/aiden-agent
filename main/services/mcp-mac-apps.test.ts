import assert from "node:assert/strict";
import test from "node:test";
import { isMcpMacAppOpen, mcpMacAppStatus, openMcpMacApp, type McpMacAppProbe } from "./mcp-mac-apps.js";
import { getMcpPreset, serverFromPreset, type MacAppMcpPreset } from "./mcp-presets.js";

const imcp = getMcpPreset("imcp") as MacAppMcpPreset;
const HOME = "/Users/me";
const SYSTEM_SERVER = "/Applications/iMCP.app/Contents/MacOS/imcp-server";
const USER_SERVER = "/Users/me/Applications/iMCP.app/Contents/MacOS/imcp-server";

interface FakeBundle {
  bundleId?: string;
  version?: string;
  /** The server inside the bundle is present and executable. */
  server?: boolean;
}

/** A Mac with these app bundles, by bundle path, and these running process names. */
function fakeMac(bundles: Record<string, FakeBundle>, running: string[] = [], platform: NodeJS.Platform = "darwin") {
  const calls: string[] = [];
  const opened: string[] = [];
  const probe: McpMacAppProbe = {
    platform,
    homedir: HOME,
    isExecutable: async (file) => {
      calls.push(`exec:${file}`);
      return Object.entries(bundles).some(([bundle, info]) => info.server !== false && file === `${bundle}/Contents/MacOS/imcp-server`);
    },
    bundleInfo: async (bundle, key) => {
      calls.push(`info:${bundle}:${key}`);
      const info = bundles[bundle];
      return key === "CFBundleIdentifier" ? info?.bundleId : info?.version;
    },
    isRunning: async (name) => {
      calls.push(`running:${name}`);
      return running.includes(name);
    },
    open: async (bundle) => {
      opened.push(bundle);
    },
  };
  return { probe, calls, opened };
}

test("iMCP counts as installed only with its server and its own bundle identifier, /Applications first", async () => {
  assert.deepEqual(await mcpMacAppStatus(imcp, fakeMac({}).probe), { supported: true, installed: false, open: false });

  const both = fakeMac({
    "/Applications/iMCP.app": { bundleId: "co.dododo.iMCP", version: "1.6.0" },
    "/Users/me/Applications/iMCP.app": { bundleId: "co.dododo.iMCP", version: "1.5.0" },
  });
  assert.deepEqual(await mcpMacAppStatus(imcp, both.probe), {
    supported: true,
    installed: true,
    command: SYSTEM_SERVER,
    version: "1.6.0",
    open: false,
  });

  // Another app named iMCP.app, or a bundle without its server, is passed over for the real copy.
  for (const impostor of [{ bundleId: "com.example.other" }, { bundleId: "co.dododo.iMCP", server: false }]) {
    const mac = fakeMac({
      "/Applications/iMCP.app": impostor,
      "/Users/me/Applications/iMCP.app": { bundleId: "co.dododo.iMCP" },
    });
    const status = await mcpMacAppStatus(imcp, mac.probe);
    assert.equal(status.command, USER_SERVER, JSON.stringify(impostor));
    assert.equal(status.version, undefined, "no version is invented");
  }
  const onlyImpostor = fakeMac({ "/Applications/iMCP.app": { bundleId: "com.example.other" } });
  assert.equal((await mcpMacAppStatus(imcp, onlyImpostor.probe)).installed, false);
});

test("the command iMCP's status reports is one main accepts for the iMCP connector", async () => {
  for (const bundle of ["/Applications/iMCP.app", "/Users/me/Applications/iMCP.app"]) {
    const status = await mcpMacAppStatus(imcp, fakeMac({ [bundle]: { bundleId: "co.dododo.iMCP" } }).probe);
    const server = serverFromPreset(imcp, status.command, { platform: "darwin", homedir: HOME });
    assert.equal(server.command, status.command);
  }
});

test("open follows the running iMCP app, and a closed app is reported before any connection", async () => {
  const installed = { "/Applications/iMCP.app": { bundleId: "co.dododo.iMCP" } };
  assert.equal((await mcpMacAppStatus(imcp, fakeMac(installed, ["iMCP"]).probe)).open, true);
  assert.equal((await mcpMacAppStatus(imcp, fakeMac(installed, ["Finder"]).probe)).open, false);
  assert.equal(await isMcpMacAppOpen(imcp, fakeMac(installed, ["iMCP"]).probe), true);
  assert.equal(await isMcpMacAppOpen(imcp, fakeMac(installed).probe), false);
});

test("Open opens the installed copy that Aiden runs, and nothing when iMCP isn't installed", async () => {
  const mac = fakeMac({ "/Users/me/Applications/iMCP.app": { bundleId: "co.dododo.iMCP" } });
  await openMcpMacApp(imcp, mac.probe);
  assert.deepEqual(mac.opened, ["/Users/me/Applications/iMCP.app"]);

  const empty = fakeMac({ "/Applications/Other.app": { bundleId: "co.dododo.iMCP" } });
  await assert.rejects(openMcpMacApp(imcp, empty.probe), /isn’t in your Applications folder/u);
  assert.deepEqual(empty.opened, []);
});

test("off a Mac nothing is looked up, checked or opened", async () => {
  const linux = fakeMac({ "/Applications/iMCP.app": { bundleId: "co.dododo.iMCP" } }, ["iMCP"], "linux");
  assert.deepEqual(await mcpMacAppStatus(imcp, linux.probe), { supported: false, installed: false, open: false });
  assert.equal(await isMcpMacAppOpen(imcp, linux.probe), false);
  await assert.rejects(openMcpMacApp(imcp, linux.probe), /works only on a Mac/u);
  assert.deepEqual(linux.calls, []);
  assert.deepEqual(linux.opened, []);
});
