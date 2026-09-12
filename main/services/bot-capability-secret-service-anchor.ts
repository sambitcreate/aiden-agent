import { linuxDesktopBusEnvironment as secretServiceAuthorityEnvironment } from "./linux-desktop-bus-environment.js";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
import { createAuthorityItem, createAuthorityBootstrapMarker, ROLLBACK_SERVICE, BOOTSTRAP_SERVICE, TELEGRAM_BINDING_SERVICE, TELEGRAM_BINDING_BOOTSTRAP_SERVICE, validateAccount, validateValue, type BotCapabilityAuthorityItemOptions } from "./bot-capability-authority-item.js";

const SERVICES = new Set([ROLLBACK_SERVICE, BOOTSTRAP_SERVICE, TELEGRAM_BINDING_SERVICE, TELEGRAM_BINDING_BOOTSTRAP_SERVICE]);
export interface AuthorityHelperRuntime { cwd: string; resourcesPath?: string; defaultApp?: boolean; }
export function resolveSecretServiceAuthorityHelper(runtime: AuthorityHelperRuntime = {
  cwd: process.cwd(), resourcesPath: process.resourcesPath, defaultApp: process.defaultApp,
}): string {
  return runtime.resourcesPath && !runtime.defaultApp
    ? path.resolve(runtime.resourcesPath, "..", "Helpers", "aiden-secret-service-authority")
    : path.resolve(runtime.cwd, "build", "native", "aiden-secret-service-authority");
}
export type SecretServiceAuthorityCommand = (args: readonly string[], stdin?: string) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export { linuxDesktopBusEnvironment as secretServiceAuthorityEnvironment } from "./linux-desktop-bus-environment.js";

/** Secrets never enter argv or diagnostics. No file-backed fallback is permitted. */
export function createSecretServiceAuthorityCommand(helper = resolveSecretServiceAuthorityHelper(), timeoutMs = 5_000): SecretServiceAuthorityCommand {
  return async (args, stdin) => {
    if (args.length !== 3 || !["lookup", "store"].includes(args[0]!) || !SERVICES.has(args[1]!) ||
        (args[0] === "store") !== (stdin !== undefined)) throw new BotCapabilityUnavailableError("Secret Service command is invalid.");
    validateAccount(args[2]!);
    if (stdin !== undefined) validateValue(stdin);
    return new Promise((resolve, reject) => {
      const child = spawn(helper, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: secretServiceAuthorityEnvironment() });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new BotCapabilityUnavailableError("Secret Service helper is unavailable."));
      };
      const timer = setTimeout(fail, timeoutMs);
      const capture = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > 4_096) { fail(); return; }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.once("error", fail);
      child.stdin.once("error", fail);
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      child.stdin.end(stdin);
    });
  };
}
interface Options extends BotCapabilityAuthorityItemOptions { command?: SecretServiceAuthorityCommand; }
function item(options: Options, service: string, label: string) {
  const command = options.command ?? createSecretServiceAuthorityCommand();
  return createAuthorityItem(options, {
    async read(account) {
      const result = await command(["lookup", service, account]);
      if (result.exitCode === 4 && result.stdout === "") return null;
      if (result.exitCode !== 0) throw new BotCapabilityUnavailableError("Secret Service authority is unavailable.");
      return result.stdout;
    },
    async write(account, value) {
      const result = await command(["store", service, account], value);
      if (result.exitCode !== 0 || result.stdout !== "") throw new BotCapabilityUnavailableError("Secret Service authority could not be updated.");
    },
  }, label);
}
export const createBotCapabilitySecretServiceAnchor = (options: Options) => item(options, ROLLBACK_SERVICE, "Bot rollback authority");
export const createBotCapabilitySecretServiceBootstrapMarker = (options: Options) => createAuthorityBootstrapMarker(item(options, BOOTSTRAP_SERVICE, "Bot bootstrap marker"));
export const createTelegramBotBindingSecretServiceAnchor = (options: Options) => item(options, TELEGRAM_BINDING_SERVICE, "Telegram Bot binding rollback authority");
export const createTelegramBotBindingSecretServiceBootstrapMarker = (options: Options) => item(options, TELEGRAM_BINDING_BOOTSTRAP_SERVICE, "Telegram Bot binding bootstrap marker");
