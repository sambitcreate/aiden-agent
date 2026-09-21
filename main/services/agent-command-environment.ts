import * as path from "node:path";

/** GUI launches on macOS often inherit launchd's short PATH rather than the user's shell PATH. */
export function agentCommandEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...parent };
  if (platform !== "darwin") return env;

  const home = parent.HOME;
  const candidates = [
    ...(home && path.isAbsolute(home) ? [path.join(home, ".local", "bin")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
  ];
  const inherited = (parent.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")
    .split(path.delimiter)
    .filter(Boolean);
  const missing = candidates.filter((candidate) => !inherited.includes(candidate));
  env.PATH = [...inherited, ...missing].join(path.delimiter);
  return env;
}
