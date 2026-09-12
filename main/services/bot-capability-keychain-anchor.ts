import { spawn } from "node:child_process";
import type { BotCapabilityRollbackAnchor, BotCapabilityBootstrapMarker } from "./bot-capability-state-checkpoint.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
import { ROLLBACK_SERVICE, BOOTSTRAP_SERVICE, TELEGRAM_BINDING_SERVICE, TELEGRAM_BINDING_BOOTSTRAP_SERVICE, validateValue, createAuthorityItem, createAuthorityBootstrapMarker, type BotCapabilityAuthorityItemOptions } from "./bot-capability-authority-item.js";
export { botCapabilityAuthorityAccountForCanonicalRoot as botCapabilityKeychainAccountForCanonicalRoot } from "./bot-capability-authority-item.js";
const SECURITY = "/usr/bin/security";
const MAX_PROCESS_OUTPUT_BYTES = 4_096;
const PROCESS_TIMEOUT_MS = 5_000;
const SECURITY_INTERACTIVE_TOKEN = /^[A-Za-z0-9._:-]+$/u;
export interface BotCapabilitySecurityCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type BotCapabilitySecurityCommand = (
  args: readonly string[],
  stdin?: string,
) => Promise<BotCapabilitySecurityCommandResult>;

export function botCapabilitySecurityInteractiveWrite(
  args: readonly string[],
  value: string,
): string {
  if (
    args[0] !== "add-generic-password" ||
    args[args.length - 1] !== "-w" ||
    args.length > 16 ||
    args.slice(0, -1).some(
      (token) => token.length === 0 ||
        token.length > 256 ||
        !SECURITY_INTERACTIVE_TOKEN.test(token),
    )
  ) {
    throw new BotCapabilityUnavailableError(
      "The macOS Keychain write command is invalid.",
    );
  }
  const hexValue = Buffer.from(validateValue(value), "utf8").toString("hex");
  return `${args.slice(0, -1).join(" ")} -X ${hexValue}\n`;
}

const runSecurity: BotCapabilitySecurityCommand = (args, stdin) =>
  new Promise((resolve, reject) => {
    const interactiveWrite = stdin === undefined
      ? undefined
      : botCapabilitySecurityInteractiveWrite(args, stdin);
    const child = spawn(SECURITY, interactiveWrite === undefined ? [...args] : ["-i"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        finishError(
          new Error("macOS security command output exceeded its bound."),
        );
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", finishError);
    child.stdin.once("error", finishError);
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    const timeout = setTimeout(
      () => finishError(new Error("macOS security command timed out.")),
      PROCESS_TIMEOUT_MS,
    );
    // Interactive mode keeps the value in stdin while `-X` avoids a terminal
    // password prompt. Omitting `-T` intentionally retains the default creator ACL.
    child.stdin.end(interactiveWrite);
  });

interface BotCapabilityKeychainItemOptions extends BotCapabilityAuthorityItemOptions {
  command?: BotCapabilitySecurityCommand;
}
function createKeychainItem(options: BotCapabilityKeychainItemOptions, service: string, label: string): BotCapabilityRollbackAnchor {
  const command = options.command ?? runSecurity;
  return createAuthorityItem(options, {
    async read(account) {
      const result = await command(["find-generic-password", "-a", account, "-s", service, "-w"]);
      if (result.exitCode === 44 || /could not be found/iu.test(result.stderr)) return null;
      if (result.exitCode !== 0) throw new BotCapabilityUnavailableError(`The macOS Keychain ${label} is unavailable.`);
      return result.stdout.replace(/\r?\n$/u, "");
    },
    async write(account, value) {
      const result = await command(["add-generic-password", "-U", "-a", account, "-s", service, "-w"], value);
      if (result.exitCode !== 0) throw new BotCapabilityUnavailableError(`The macOS Keychain ${label} could not be updated.`);
    },
  }, label);
}
export function createBotCapabilityKeychainAnchor(
  options: BotCapabilityKeychainItemOptions,
): BotCapabilityRollbackAnchor {
  return createKeychainItem(
    options,
    ROLLBACK_SERVICE,
    "Bot rollback authority",
  );
}

/** Independent rollback authority for Telegram Bot route generations. */
export function createTelegramBotBindingKeychainAnchor(
  options: BotCapabilityKeychainItemOptions,
): BotCapabilityRollbackAnchor {
  return createKeychainItem(
    options,
    TELEGRAM_BINDING_SERVICE,
    "Telegram Bot binding rollback authority",
  );
}

/** One-way marker preventing a missing Telegram authority from re-bootstraping. */
export function createTelegramBotBindingKeychainBootstrapMarker(
  options: BotCapabilityKeychainItemOptions,
): BotCapabilityRollbackAnchor {
  return createKeychainItem(
    options,
    TELEGRAM_BINDING_BOOTSTRAP_SERVICE,
    "Telegram Bot binding bootstrap marker",
  );
}

export function createBotCapabilityKeychainBootstrapMarker(options: BotCapabilityKeychainItemOptions): BotCapabilityBootstrapMarker {
  return createAuthorityBootstrapMarker(createKeychainItem(options, BOOTSTRAP_SERVICE, "Bot bootstrap marker"));
}
