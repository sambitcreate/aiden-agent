import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AidenRemoteDesktopPairing } from "../../../main/services/aiden-remote-pairing.js";
import { CLI_COMMAND_HELP } from "./command-help.ts";

// Each command loads its own module on demand: the interactive session path
// calls dispatchCommand first and should not evaluate the daemon, Telegram,
// speech, or pairing code it is not going to run.
export async function dispatchCommand(agentDir: string, cwd: string, args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  let result: unknown;
  switch (command) {
    case "workspace": result = await (await import("./workspaces.ts")).workspaceCommand(agentDir, rest); break;
    case "search": result = await (await import("./sessions.ts")).searchSessions(agentDir, rest.join(" ")); break;
    case "import": if (!rest[0]) throw new Error("Provide an Aiden export or session journal."); result = await (await import("./session-import.ts")).importSession(agentDir, cwd, rest[0]); break;
    case "export": {
      if (!rest[0]) throw new Error("Usage: export <session.jsonl> [output.aiden-chat.json]");
      const source = realpathSync(resolve(rest[0]));
      result = await (await import("./session-import.ts")).exportSessionFile(agentDir, source, rest[1] ?? `${source}.aiden-chat.json`); break;
    }
    case "mcp": result = await (await import("./mcp.ts")).mcpCommand(agentDir, rest); break;
    case "auth": result = await (await import("./auth.ts")).authCommand(agentDir, rest); break;
    case "catalog": result = await (await import("./providers.ts")).catalogCommand(agentDir, rest); break;
    case "insights": result = await (await import("./providers.ts")).insightsCommand(agentDir, rest); break;
    case "files": result = await (await import("./git-commands.ts")).filesCommand(cwd, rest); break;
    case "git": result = await (await import("./git-commands.ts")).gitCommand(cwd, rest); break;
    case "worktree": result = await (await import("./git-commands.ts")).worktreeCommand(agentDir, cwd, rest); break;
    case "schedule": result = await (await import("./schedules.ts")).scheduleCommand(agentDir, rest); break;
    case "telegram": result = await (await import("./telegram.ts")).telegramCommand(agentDir, rest); break;
    case "speech": result = await (await import("./speech.ts")).speechCommand(agentDir, rest); break;
    case "bots": result = await (await import("./schedules.ts")).remoteDaemonCommand(agentDir, "bots", rest); break;
    case "remote": {
      result = await (await import("./schedules.ts")).remoteDaemonCommand(agentDir, "remote", rest);
      if (rest[0] === "pair" && !process.stdout.isTTY) {
        process.stderr.write("warning: the pairing payload below contains a single-use secret — keep it out of logs.\n");
      }
      if (rest[0] === "pair" && process.stdout.isTTY) {
        const rendered = await (await import("./pairing-display.ts")).renderPairingTerminal(result as AidenRemoteDesktopPairing).catch(() => undefined);
        if (rendered) { process.stdout.write(rendered + "\n"); return true; }
      }
      break;
    }
    case "serve": {
      const { daemonStatus, startDaemon, stopDaemon } = await import("./serve-lifecycle.ts");
      if (rest[0] === "stop" || rest[0] === "status") {
        if (rest.length !== 1) throw new Error(`Usage: aiden serve ${rest[0]}`);
        result = rest[0] === "stop" ? await stopDaemon(agentDir) : daemonStatus(agentDir);
        break;
      }
      const unknown = rest.filter((arg) => arg !== "--remote" && arg !== "--daemon");
      if (unknown.length) throw new Error("Usage: aiden serve [--remote] [--daemon] | serve stop | serve status");
      const remote = rest.includes("--remote");
      if (rest.includes("--daemon")) { result = await startDaemon(agentDir, { remote }); break; }
      const controller = new AbortController(); const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try { await (await import("./serve.ts")).serve(agentDir, controller.signal, { remote }); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
      return true;
    }
    case "provider": {
      if ((rest[0] ?? "list") === "list") { result = (await (await import("./providers.ts")).createCliModelRuntime(agentDir)).getProviders().map(({ id, name }) => ({ id, name })); break; }
      if (rest[0] !== "import" || !rest[1]) throw new Error("Usage: provider list | import <models.json>");
      const value = JSON.parse(readFileSync(resolve(rest[1]), "utf8"));
      result = await (await import("./providers.ts")).importProviders(agentDir, value);
      break;
    }
    case "web-search": {
      const { normalizeWebSearchSettings } = await import("../../../main/services/web-search-provider-registry-core.js");
      const { atomicJson, readJson } = await import("./state.ts");
      const file = join(agentDir, "web-search.json");
      if ((rest[0] ?? "show") === "show") result = normalizeWebSearchSettings(readJson(file, undefined));
      else if (rest[0] === "import" && rest[1]) { result = normalizeWebSearchSettings(JSON.parse(readFileSync(rest[1], "utf8"))); atomicJson(file, result); }
      else throw new Error("Usage: web-search show | import <settings.json>");
      break;
    }
    case "theme": {
      const { parseThemeVariantJson } = await import("../../../renderer/shared/appearance.ts");
      const { buildTheme } = await import("./theme.ts");
      const { atomicJson, readJson } = await import("./state.ts");
      const [action, source, scheme, name] = rest;
      if (action === "import") {
        if (!source || !["light", "dark"].includes(scheme) || !name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("Usage: theme import <variant.json> <light|dark> <name>");
        const variant = parseThemeVariantJson(readFileSync(source, "utf8"), scheme as "light" | "dark");
        const theme = buildTheme(name, scheme as "light" | "dark", variant); theme.name = name;
        atomicJson(join(agentDir, "themes", `${name}.json`), theme);
        atomicJson(join(agentDir, "theme-variants", `${name}.json`), { version: 1, scheme, theme: variant });
        result = { imported: name }; break;
      }
      if (action === "export" && source && scheme && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source)) {
        const value = readJson(join(agentDir, "theme-variants", `${source}.json`), null);
        if (!value) throw new Error("Imported theme not found.");
        atomicJson(resolve(scheme), value); result = { exported: resolve(scheme) }; break;
      }
      throw new Error("Usage: theme import <variant.json> <light|dark> <name> | export <name> <file>");
    }
    case "reset": {
      const { onboardingProgressState } = await import("../../../main/services/onboarding-state-core.js");
      const { atomicJson } = await import("./state.ts");
      atomicJson(join(agentDir, "onboarding.json"), onboardingProgressState("incomplete", { profileReady: false, providerReady: false }));
      result = { onboardingReset: true }; break;
    }
    case "help": process.stdout.write(CLI_COMMAND_HELP); return true;
    default: return false;
  }
  process.stdout.write(JSON.stringify(result ?? null, null, 2) + "\n");
  return true;
}
