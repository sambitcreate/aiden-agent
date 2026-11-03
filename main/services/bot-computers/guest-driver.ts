// The guest driver lane's transport (plan §8.6): a `CuaDriverHostFactory`
// whose sessions are MCP over one SSH child per session. The child runs
// `cua-driver mcp --embedded --socket <guest socket>` in the guest
// (`guestDriverBridgeScript`), which relays to the LaunchAgent daemon in the
// logged-in session. `CuaDriverSession` then checks the exact pinned catalog
// (schema and capability versions, Aiden's allowlist, every required tool)
// before any call, as it does for the Mac's own driver.
//
// SSH is Aiden's own: its key, the pinned host key, no agent, no forwarding.
// The child's environment is ssh's fixed one; nothing of Aiden's reaches it.

import { spawn, type ChildProcess } from "node:child_process";
import { CuaDriverSession } from "../computer-use/session.js";
import type { CuaDriverHostFactory, CuaDriverHostLike, CuaDriverSessionLike } from "../computer-use/controller.js";
import { guestDriverBridgeScript, type GuestDriverLocation } from "./guest-driver-install.js";
import { guestRemoteCommand, guestSshArgs, type GuestSshPaths, type GuestSshTarget } from "./ssh.js";

/** One child process that speaks MCP on its stdio. */
export interface GuestDriverBridgeCommand {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

/** How long one bridge may live: the guest's own alarm ends it after this. */
export const GUEST_DRIVER_BRIDGE_LIFETIME_MS = 6 * 60 * 60_000;

/** `/usr/bin/ssh <Aiden's options> -l lume -- <ip> <bridge script>`. */
export function guestDriverSshBridge(
  target: GuestSshTarget,
  location: GuestDriverLocation,
  options: { paths: GuestSshPaths; env: Record<string, string>; sshCommand?: string },
): GuestDriverBridgeCommand {
  return {
    command: options.sshCommand ?? "/usr/bin/ssh",
    args: [
      ...guestSshArgs(target, options.paths),
      guestRemoteCommand(guestDriverBridgeScript(location), GUEST_DRIVER_BRIDGE_LIFETIME_MS),
    ],
    env: options.env,
  };
}

export interface GuestCuaDriverHostOptions {
  /** The bridge for the computer's current run; read once per session. */
  bridge(): GuestDriverBridgeCommand | Promise<GuestDriverBridgeCommand>;
  /** Test seam. */
  spawnImpl?: typeof spawn;
  connectTimeoutMs?: number;
}

const STDERR_TAIL_BYTES = 4_096;

function spawnBridge(command: GuestDriverBridgeCommand, spawnImpl: typeof spawn): { child: ChildProcess; diagnostic(): string } {
  const child = spawnImpl(command.command, [...command.args], {
    detached: false,
    env: command.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
  });
  return { child, diagnostic: () => stderr };
}

/**
 * The guest lane's host for `ComputerUseController`: every `createSession`
 * starts a bridge and connects (catalog check plus `start_session`); shutdown
 * closes every session it made.
 */
export function createGuestCuaDriverHostFactory(options: GuestCuaDriverHostOptions): CuaDriverHostFactory {
  const spawnImpl = options.spawnImpl ?? spawn;
  return async (factorySignal) => {
    const sessions = new Set<CuaDriverSession>();
    let closed = false;
    const host: CuaDriverHostLike = {
      async createSession(signal?: AbortSignal): Promise<CuaDriverSessionLike> {
        if (closed || factorySignal.aborted) throw new Error("The guest driver host has shut down.");
        const bridge = await options.bridge();
        // Shutdown may have run while the bridge resolved: it closed only the sessions it saw.
        if (closed || factorySignal.aborted) throw new Error("The guest driver host has shut down.");
        const { child, diagnostic } = spawnBridge(bridge, spawnImpl);
        child.once("error", () => undefined);
        const session = new CuaDriverSession({
          bridge: child,
          diagnostic,
          onClosed: (closedSession) => sessions.delete(closedSession),
        });
        sessions.add(session);
        const deadline = options.connectTimeoutMs !== undefined ? Date.now() + options.connectTimeoutMs : undefined;
        try {
          await session.connect(signal ? AbortSignal.any([signal, factorySignal]) : factorySignal, deadline);
        } catch (error) {
          sessions.delete(session);
          await session.close().catch(() => undefined);
          throw error;
        }
        return session;
      },
      async shutdown() {
        closed = true;
        await Promise.all([...sessions].map((session) => session.close().catch(() => undefined)));
        sessions.clear();
      },
    };
    return host;
  };
}
