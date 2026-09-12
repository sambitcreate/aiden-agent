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

/** Preserve only the local desktop bus address, never ambient credentials or loader hooks. */
export function secretServiceAuthorityEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
  const runtimeDir = source.XDG_RUNTIME_DIR;
  if (runtimeDir && runtimeDir.length <= 4096 && path.isAbsolute(runtimeDir) &&
      !/[\x00-\x1f\x7f]/u.test(runtimeDir) && path.normalize(runtimeDir) === runtimeDir) {
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
