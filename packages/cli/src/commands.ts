import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AidenRemoteDesktopPairing } from "../../../main/services/aiden-remote-pairing.js";
import { CLI_COMMAND_HELP } from "./command-help.ts";

// Each command loads its own module on demand, so an administration command
// does not evaluate the daemon, Telegram, speech, or pairing code it is not
// going to run.
export async function dispatchCommand(agentDir: string, cwd: string, args: string[]): Promise<boolean> {
  const [command, ...rest] = args;
  let result: unknown;
  switch (command) {
    case "app": {
      const [action = "help", subject = "overview", rawValue, revision, operationId] = rest;
      if (action === "help") { result = (await import("../../../main/services/aiden-app-knowledge.js")).readAidenHelp(rest.slice(1).join(" ") || "overview"); break; }
      const { isAppControlId } = await import("../../../renderer/shared/app-controls.js");
      const { CLI_APP_TOPICS, createCliAppControls, isCliAppTopic } = await import("./app-controls.ts");
      const controls = createCliAppControls(agentDir);
      if (action === "status") { result = await Promise.all(CLI_APP_TOPICS.map((topic) => controls.snapshot(topic))); break; }
      if (action === "get" && isCliAppTopic(subject)) { result = await controls.snapshot(subject); break; }
      if (action === "set" && isAppControlId(subject) && rawValue !== undefined && revision && rest.length <= 5) {
        const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
        const { randomUUID } = await import("node:crypto");
        result = await controls.apply({ control: subject, value, expectedRevision: revision, operationId: operationId ?? randomUUID() }); break;
      }
      throw new Error("Usage: aiden app help [query] | status | get <topic> | set <control> <value> <revision> [operation-id]");
    }
    case "workspace": result = await (await import("./workspaces.ts")).workspaceCommand(agentDir, rest); break;
    case "search": result = await (await import("./sessions.ts")).searchSessions(agentDir, rest.join(" ")); break;
    case "import": if (!rest[0]) throw new Error("Provide an Aiden export or session journal."); result = await (await import("./session-import.ts")).importSession(agentDir, cwd, rest[0]); break;
    case "export": {
      if (!rest[0]) throw new Error("Usage: export <session.jsonl> [output.aiden-chat.json]");
      const source = realpathSync(resolve(rest[0]));
      result = await (await import("./session-import.ts")).exportSessionFile(agentDir, source, rest[1] ?? `${source}.aiden-chat.json`); break;
    }
    case "mcp": result = await (await import("./mcp.ts")).mcpCommand(agentDir, rest); break;
    case "hooks": result = await (await import("./hooks.ts")).hooksAdminCommand(agentDir, rest); break;
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
      if (rest[0] === "check") {
        if (rest.length !== 1) throw new Error("Usage: aiden remote check");
        if (!await (await import("./reachability.ts")).remoteCheckCommand(agentDir)) process.exitCode = 1;
        return true;
      }
      if (rest[0] === "pair" && rest[1] === "tailscale" && rest.length === 2) {
        // Progress goes to stderr when stdout carries the pairing JSON.
        await (await import("./reachability.ts")).prepareTailscalePairing(agentDir, new AbortController().signal, process.stdout.isTTY ? process.stdout : process.stderr, process.stderr);
      }
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
    case "serve": await (await import("./serve-command.ts")).serveCommand(agentDir, rest); return true;
    case "service": await (await import("./service.ts")).serviceCommand(agentDir, rest); return true;
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
    case "help": process.stdout.write(CLI_COMMAND_HELP); return true;
    default: return false;
  }
  process.stdout.write(JSON.stringify(result ?? null, null, 2) + "\n");
  return true;
}
