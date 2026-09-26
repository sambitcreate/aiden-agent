import { onboardingProgressState } from "../../../main/services/onboarding-state-core.js";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseThemeVariantJson } from "../../../renderer/shared/appearance.ts";
import { normalizeWebSearchSettings } from "../../../main/services/web-search-provider-registry-core.js";
import { workspaceCommand } from "./workspaces.ts";
import { importSession, exportSessionFile } from "./session-import.ts";
import { searchSessions } from "./sessions.ts";
import { mcpCommand } from "./mcp.ts";
import { authCommand } from "./auth.ts";
import { catalogCommand, insightsCommand, createCliModelRuntime, importProviders } from "./providers.ts";
import { gitCommand, worktreeCommand, filesCommand } from "./git-commands.ts";
import { scheduleCommand, remoteDaemonCommand } from "./schedules.ts";
import { serve } from "./serve.ts";
import { daemonStatus, startDaemon, stopDaemon } from "./serve-lifecycle.ts";
import { atomicJson, readJson } from "./state.ts";
import { buildTheme } from "./theme.ts";
import { telegramCommand } from "./telegram.ts";
import { speechCommand } from "./speech.ts";
import { renderPairingTerminal } from "./pairing-display.ts";
import type { AidenRemoteDesktopPairing } from "../../../main/services/aiden-remote-pairing.js";

export const CLI_COMMAND_HELP = `Aiden commands:
  workspace list|add|remove|access|scratch    Workspace registry and tool approval tiers
  search <query>                            Search all session titles/previews
  import <desktop-journal|aiden-chat.json>   Copy a conversation into a new CLI session
  export <session.jsonl> [output.aiden-chat.json]
  auth list|login|logout                     Provider credentials (OAuth or API key)
  mcp list|presets|add|preset|login|remove    MCP servers and browser OAuth
  provider list|import <models.json>         Custom OpenAI-compatible/Ollama/LM Studio providers
  catalog refresh|models-dev fetch|models-dev status
  insights aa|openrouter show|fetch|disconnect
  theme import <variant.json> <light|dark> <name> | export <name> <file>
  web-search show|import <settings.json>     Provider routing; keys from environment
  files list|read <relative-path>           Inspect bounded workspace files
  git status|review|branches|worktrees
  worktree list|create <branch>|remove <path>
  schedule list|save <file>|preview <cron> [timezone]|runs|notifications [since-ms]|run|pause|resume|remove <id>
  telegram status|connect|configure <file>|disable|disconnect
  speech status|download|select|delete <id>|transcribe <pcm16-file> <model-id>
  serve [--remote] [--daemon] | stop | status   Scheduling, Telegram, and Remote daemon
  remote status|devices|pair lan|tailscale|pair-status|pair-cancel <id>|revoke <id>|roots|approve-root <path>
  bots list|get|catalog|notice|acknowledge|create|update|archive|restore|access|chat|chat-access
  reset                                     Reset first-run onboarding only
`;
export async function dispatchCommand(agentDir: string, cwd: string, args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  let result: unknown;
  switch (command) {
    case "workspace": result = await workspaceCommand(agentDir, rest); break;
    case "search": result = await searchSessions(agentDir, rest.join(" ")); break;
    case "import": if (!rest[0]) throw new Error("Provide an Aiden export or session journal."); result = await importSession(agentDir, cwd, rest[0]); break;
    case "export": {
      if (!rest[0]) throw new Error("Usage: export <session.jsonl> [output.aiden-chat.json]");
      const source = realpathSync(resolve(rest[0]));
      result = await exportSessionFile(agentDir, source, rest[1] ?? `${source}.aiden-chat.json`); break;
    }
    case "mcp": result = await mcpCommand(agentDir, rest); break;
    case "auth": result = await authCommand(agentDir, rest); break;
    case "catalog": result = await catalogCommand(agentDir, rest); break;
    case "insights": result = await insightsCommand(agentDir, rest); break;
    case "files": result = await filesCommand(cwd, rest); break;
    case "git": result = await gitCommand(cwd, rest); break;
    case "worktree": result = await worktreeCommand(agentDir, cwd, rest); break;
    case "schedule": result = await scheduleCommand(agentDir, rest); break;
    case "telegram": result = await telegramCommand(agentDir, rest); break;
    case "speech": result = await speechCommand(agentDir, rest); break;
    case "bots": result = await remoteDaemonCommand(agentDir, "bots", rest); break;
    case "remote": {
      result = await remoteDaemonCommand(agentDir, "remote", rest);
      if (rest[0] === "pair" && !process.stdout.isTTY) {
        process.stderr.write("warning: the pairing payload below contains a single-use secret — keep it out of logs.\n");
      }
      if (rest[0] === "pair" && process.stdout.isTTY) {
        const rendered = await renderPairingTerminal(result as AidenRemoteDesktopPairing).catch(() => undefined);
        if (rendered) { process.stdout.write(rendered + "\n"); return true; }
      }
      break;
    }
    case "serve": {
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
      try { await serve(agentDir, controller.signal, { remote }); } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
      return true;
    }
    case "provider": {
      if ((rest[0] ?? "list") === "list") { result = (await createCliModelRuntime(agentDir)).getProviders().map(({ id, name }) => ({ id, name })); break; }
      if (rest[0] !== "import" || !rest[1]) throw new Error("Usage: provider list | import <models.json>");
      const value = JSON.parse(readFileSync(resolve(rest[1]), "utf8"));
      result = await importProviders(agentDir, value);
      break;
    }
    case "web-search": {
      const file = join(agentDir, "web-search.json");
      if ((rest[0] ?? "show") === "show") result = normalizeWebSearchSettings(readJson(file, undefined));
      else if (rest[0] === "import" && rest[1]) { result = normalizeWebSearchSettings(JSON.parse(readFileSync(rest[1], "utf8"))); atomicJson(file, result); }
      else throw new Error("Usage: web-search show | import <settings.json>");
      break;
    }
    case "theme": {
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
    case "reset": atomicJson(join(agentDir, "onboarding.json"), onboardingProgressState("incomplete", { profileReady: false, providerReady: false })); result = { onboardingReset: true }; break;
    case "help": process.stdout.write(CLI_COMMAND_HELP); return true;
    default: return false;
  }
  process.stdout.write(JSON.stringify(result ?? null, null, 2) + "\n");
  return true;
}
