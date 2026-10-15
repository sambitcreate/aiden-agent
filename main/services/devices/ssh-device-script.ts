/**
 * Adapted from t3code apps/server/src/device/sshDeviceScript.ts @ a6ec88f7 (MIT)
 *
 * The program Aiden pipes to `node` on an SSH device host. Every mode prints
 * one JSON line on success; paths it returns belong to that host. State is
 * kept per owner (one Aiden install talking to one host entry) under
 * `~/.aiden/devices/hosts/<owner>`, and pinned tools under
 * `~/.aiden/devices/tools/<name>@<version>`.
 *
 * Unlike T3, a start never installs unless Aiden passes `allowInstall`, which
 * it does only for the user's explicit Install or Update. A missing tool exits
 * with code 3 and `missing-tool:<name>` so the caller can ask for consent.
 */
import { deviceToolMaintenanceScript } from "./device-tool-maintenance.js";
import { AGENT_DEVICE, DEVICE_HUB } from "./device-toolchain.js";

export type SshDeviceScriptMode = "probe" | "start" | "agent-start" | "stop-agent" | "stop";

export const SSH_MISSING_TOOL_EXIT = 3;
export const SSH_MISSING_TOOL_PREFIX = "missing-tool:";
export const REMOTE_NODE_MAJOR = 22;

export const quoteRemoteArg = (value: string): string => `'${value.split("'").join(`'"'"'`)}'`;

/** Common non-interactive Node locations, without sourcing the user's shell scripts. */
export const remoteDeviceEnvironment = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
`;

/** Runs before `node` starts, so a missing Node gets an actionable message instead of `command not found`. */
export const remoteNodeBootstrap = `command -v node >/dev/null 2>&1 || { echo "Node.js was not found on the host's non-interactive SSH PATH. Install Node.js ${REMOTE_NODE_MAJOR} or newer and npm, then test the connection again." >&2; exit 127; }; exec node`;

export interface RemoteDeviceScriptOptions {
  /** Install a missing pinned tool. Only an explicit Install or Update sets this. */
  allowInstall?: boolean;
}

/** Node runs this on the host. */
export function remoteDeviceScript(
  owner: string,
  mode: SshDeviceScriptMode,
  options: RemoteDeviceScriptOptions = {},
): string {
  return (
    `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const allowInstall = ${options.allowInstall === true};
const hubVersion = ${JSON.stringify(DEVICE_HUB.version)};
const agentVersion = ${JSON.stringify(AGENT_DEVICE.version)};
const nodeMajor = ${REMOTE_NODE_MAJOR};
` +
    deviceToolMaintenanceScript +
    String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.aiden', 'devices');
const state = path.join(root, 'hosts', owner);
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
class MissingTool extends Error {}
const toolVersions = (name, requiredVersion, entry, record) => {
  const directory = path.join(root, 'tools');
  const prefix = name + '@';
  let names = [];
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') return null; }
  let unreadable = false;
  const installedVersions = names.filter(item => item.startsWith(prefix)).map(item => item.slice(prefix.length)).filter(version => {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return false;
    const dir = path.join(directory, prefix + version);
    try { return fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version && fs.existsSync(path.join(dir, 'node_modules', name, entry)); }
    catch (error) { if (error.code !== 'ENOENT') unreadable = true; return false; }
  }).sort();
  if (unreadable) return null;
  let runningVersion = null;
  if (record?.entryPath && record?.pid) {
    const command = run('ps', ['-p', String(record.pid), '-o', 'command=']).stdout || '';
    runningVersion = installedVersions.find(version => {
      const install = path.join(directory, prefix + version);
      return record.entryPath === path.join(install, 'node_modules', name, entry) && command.includes(install + path.sep);
    }) ?? null;
  }
  return { requiredVersion, installedVersions, runningVersion };
};
const versions = () => {
  const result = {
    hub: toolVersions('expo-device-hub', hubVersion, 'dist/server/cli.mjs', read(path.join(state, 'hub.json'))),
    agent: toolVersions('agent-device', agentVersion, 'bin/agent-device.mjs', { ...read(path.join(state, 'agent.json')), ...read(path.join(state, 'daemon.json')) }),
  };
  return result.hub && result.agent ? result : undefined;
};
const stopHub = hub => {
  if (!hub || hub.owner !== owner) return;
  const command = run('ps', ['-p', String(hub.pid), '-o', 'command=']).stdout || '';
  if (command.includes(hub.entryPath) && command.includes(String(hub.port))) {
    try { process.kill(hub.pid, 'SIGTERM'); } catch {}
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const healthy = async (port, route) => { try { return (await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function acquireLock(lock, complete = () => false) {
  const deadline = Date.now() + 600000;
  const token = process.pid + ':' + require('node:crypto').randomUUID();
  const holder = () => { try { return fs.readlinkSync(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  while (true) {
    try {
      // Publishing the pid and token is atomic; suspension cannot leave an incomplete owner.
      fs.symlinkSync(token, lock);
      return () => { if (holder() === token) fs.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete()) return null;
      const previous = holder();
      if (previous === null) continue;
      const pid = Number(previous.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid device lock at ' + lock);
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH' && holder() === previous) {
          try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
      }
      if (Date.now() > deadline) throw Error('Another device operation holds ' + lock + '. Try again when it finishes.');
      await sleep(500);
    }
  }
}
const npmAvailable = () => run('npm', ['--version']).status === 0;
async function install(name, version, entry) {
  const dir = path.join(root, 'tools', name + '@' + version);
  const file = path.join(dir, 'node_modules', name, entry);
  const complete = () => fs.existsSync(file) && fs.existsSync(path.join(dir, '.install-complete')) && fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version;
  if (complete()) return file;
  if (!allowInstall) throw new MissingTool(name);
  if (!npmAvailable()) throw Error('npm was not found on the host\'s non-interactive SSH PATH. Install npm with Node.js ' + nodeMajor + ' or newer, then try again.');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const release = await acquireLock(dir + '.lock', complete);
  if (!release) return file;
  let staging;
  try {
    if (complete()) return file;
    staging = fs.mkdtempSync(path.join(path.dirname(dir), '.install-'));
    const result = run('npm', ['install', '--prefix', staging, '--no-fund', '--no-audit', '--ignore-scripts=false', name + '@' + version], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw Error('Installing ' + name + ' failed: ' + (result.error?.message || (result.stderr || '').slice(-2000)));
    if (!fs.existsSync(path.join(staging, 'node_modules', name, entry))) throw Error('The installed ' + name + ' has no entry point.');
    fs.writeFileSync(path.join(staging, '.install-complete'), version + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return file;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    release();
  }
}
(async () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < nodeMajor) throw Error('Node.js ' + nodeMajor + ' or newer is required on the host; found ' + process.versions.node + '. Update Node.js on the host, then test the connection again.');
  const ios = process.platform === 'darwin' && run('xcrun', ['simctl', 'help']).status === 0;
  const platforms = [{ platform: 'ios', available: ios, ...(!ios ? { reason: process.platform === 'darwin' ? 'Xcode was not found on the host. Install Xcode and open it once.' : 'iOS Simulators need a Mac with Xcode.' } : {}) }];
  if (mode === 'probe') {
    if (!npmAvailable()) throw Error('npm was not found on the host\'s non-interactive SSH PATH. Install npm with Node.js ' + nodeMajor + ' or newer, then test the connection again.');
    console.log(JSON.stringify({ nodePath: process.execPath, nodeVersion: process.versions.node, platforms, tools: versions() }));
    return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  // Starts and stops for one owner run one at a time, including agent startup.
  const releaseHost = await acquireLock(path.join(state, 'runtime.lock'));
  try {
    const hubFile = path.join(state, 'hub.json');
    const daemonFile = path.join(state, 'daemon.json');
    const agentFile = path.join(state, 'agent.json');
    if (mode === 'stop' || mode === 'stop-agent') {
      const hub = read(hubFile);
      if (mode === 'stop' && hub && hub.owner === owner) {
        stopHub(hub);
        fs.rmSync(hubFile, { force: true });
      }
      const entry = read(agentFile)?.entryPath || path.join(root, 'tools', 'agent-device@' + agentVersion, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
      if (fs.existsSync(entry)) run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]);
      fs.rmSync(daemonFile, { force: true });
      console.log(JSON.stringify({ stopped: true }));
      return;
    }
    if (!ios) throw Error(platforms[0].reason);
    const hubEntry = await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
    let hub = read(hubFile);
    if (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || !await healthy(hub.port, '/readyz')) {
      stopHub(hub);
      for (let attempt = 0; attempt < 5; attempt++) {
        const hubPort = await port();
        const log = fs.openSync(path.join(state, 'hub.log'), 'a');
        const child = spawn(process.execPath, [hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'], {
          cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
        finally { fs.closeSync(log); }
        child.unref();
        hub = { owner, pid: child.pid, port: hubPort, entryPath: hubEntry };
        write(hubFile, hub);
        const deadline = Date.now() + 30000;
        let listening = false;
        while (child.exitCode === null && child.signalCode === null) {
          if (await healthy(hub.port, '/readyz')) { listening = true; break; }
          if (Date.now() > deadline) { stopHub(hub); throw Error('The device hub did not become ready. See ' + path.join(state, 'hub.log')); }
          await sleep(200);
        }
        if (listening) break;
        // Reserving a port and binding it happen in different processes. Retry an early exit with a fresh port.
        fs.rmSync(hubFile, { force: true });
        if (attempt === 4) throw Error('The device hub exited before becoming ready. See ' + path.join(state, 'hub.log'));
      }
    }
    let agentResult = {};
    if (mode === 'agent-start') {
      const agentEntry = await install('agent-device', agentVersion, 'bin/agent-device.mjs');
      const previousAgent = read(agentFile)?.entryPath;
      let daemon = read(daemonFile);
      if (daemon && (previousAgent !== agentEntry || !await healthy(daemon.httpPort, '/health'))) {
        const stopped = run(process.execPath, [previousAgent || agentEntry, 'daemon', 'stop', '--state-dir', state]);
        if (stopped.status !== 0 && previousAgent !== agentEntry) throw Error('Could not stop the previous agent-device version.');
        fs.rmSync(daemonFile, { force: true });
        daemon = null;
      }
      if (!daemon) {
        const env = { ...process.env, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_DAEMON_SERVER_MODE: 'http', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
        delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG;
        run(process.execPath, [agentEntry, 'devices', '--json'], { env });
        daemon = read(daemonFile);
      }
      if (!daemon || !await healthy(daemon.httpPort, '/health')) throw Error('agent-device did not become ready on the host.');
      write(agentFile, { entryPath: agentEntry });
      agentResult = { daemonPort: daemon.httpPort, token: daemon.token, entryPath: agentEntry };
    }
    const vendor = path.resolve(path.dirname(hubEntry), '../../vendor/serve-sim/dist');
    const optional = file => fs.existsSync(file) ? file : null;
    // After a successful start, reclaim versions this Aiden no longer pins, keeping the last one as a fallback.
    await pruneTools(path.join(root, 'tools'), [['expo-device-hub', hubVersion], ...(mode === 'agent-start' ? [['agent-device', agentVersion]] : [])], true, true).catch(() => {});
    console.log(JSON.stringify({ nodePath: process.execPath, nodeVersion: process.versions.node, platforms, tools: versions(), hubPort: hub.port, ...agentResult,
      helpers: { axSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
  } finally { releaseHost(); }
})().catch(error => {
  if (error instanceof MissingTool) { console.error(${JSON.stringify(SSH_MISSING_TOOL_PREFIX)} + error.message); process.exitCode = ${SSH_MISSING_TOOL_EXIT}; return; }
  console.error(error.message); process.exitCode = 1;
});
`
  );
}
