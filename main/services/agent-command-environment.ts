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
  const inherited = (parent.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter);
  const missing = candidates.filter((candidate) => !inherited.includes(candidate));
  env.PATH = [...inherited, ...missing].join(path.delimiter);
  return env;
}

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/**
 * Environment for shell commands the agent runs. Aiden's own credentials (the
 * Telegram bot token, image-generation and model-insight keys) authorize only
 * Aiden, so they are withheld from workspace commands. Other variables stay,
 * including tooling credentials such as GH_TOKEN or NPM_TOKEN that builds and
 * package managers authenticate with.
 */
export function agentShellCommandEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = agentCommandEnvironment(parent, platform);
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("AIDEN_") && SECRET_NAME.test(name)) delete env[name];
  }
  return env;
}
