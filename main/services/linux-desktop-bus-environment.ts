import * as path from "node:path";

/** Preserve only the local desktop bus address, never ambient credentials or loader hooks. */
export function linuxDesktopBusEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  const runtimeDir = source.XDG_RUNTIME_DIR;
  if (runtimeDir && runtimeDir.length <= 4096 && path.isAbsolute(runtimeDir) &&
      Array.from(runtimeDir).every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) && path.normalize(runtimeDir) === runtimeDir) {
    env.XDG_RUNTIME_DIR = runtimeDir;
  }
  const bus = source.DBUS_SESSION_BUS_ADDRESS;
  // Secret Service is a local Unix session-bus service. Reject remote transports,
  // multiple addresses and malformed escaping rather than passing them to libdbus.
  if (bus && bus.length <= 4096 &&
      /^unix:(?:path=\/|abstract=)[A-Za-z0-9_./-]*(?:%[a-fA-F0-9]{2}[A-Za-z0-9_./-]*)*(?:,guid=[a-fA-F0-9]{32})?$/u.test(bus)) {
    env.DBUS_SESSION_BUS_ADDRESS = bus;
  }
  return env;
}
