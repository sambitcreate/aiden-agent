import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type {
  BotCapabilityBootstrapMarker,
  BotCapabilityBootstrapMarkerState,
  BotCapabilityRollbackAnchor,
} from "./bot-capability-state-checkpoint.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";

const SECURITY = "/usr/bin/security";
const ROLLBACK_SERVICE = "com.aiden.bot-capability.rollback-authority.v1";
const BOOTSTRAP_SERVICE = "com.aiden.bot-capability.bootstrap-consumed.v1";
const TELEGRAM_BINDING_SERVICE = "com.aiden.telegram-bot-binding.rollback-authority.v1";
const TELEGRAM_BINDING_BOOTSTRAP_SERVICE =
  "com.aiden.telegram-bot-binding.bootstrap-consumed.v1";
const MAX_VALUE_BYTES = 1_024;
const MAX_PROCESS_OUTPUT_BYTES = 4_096;
const PROCESS_TIMEOUT_MS = 5_000;
const ACCOUNT_PREFIX = "user-data:";
const MARKER_PATTERN = /^(pending|consumed):([a-f0-9]{64})$/u;
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

export function botCapabilityKeychainAccountForCanonicalRoot(
  root: string,
): string {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) {
    throw new BotCapabilityUnavailableError(
      "Bot rollback authority requires a canonical private user-data root.",
    );
  }
  return `${ACCOUNT_PREFIX}${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
}

function validateAccount(value: string): string {
  if (
    !value.startsWith(ACCOUNT_PREFIX) ||
    value.length !== ACCOUNT_PREFIX.length + 64 ||
    !/^[a-f0-9]+$/u.test(value.slice(ACCOUNT_PREFIX.length))
  ) {
    throw new BotCapabilityUnavailableError(
      "Bot rollback authority account is invalid.",
    );
  }
  return value;
}

function validateValue(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new BotCapabilityUnavailableError(
      "Bot rollback authority value is invalid.",
    );
  }
  return value;
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

interface BotCapabilityKeychainItemOptions {
  account: string | (() => string | Promise<string>);
  command?: BotCapabilitySecurityCommand;
}

function createKeychainItem(
  options: BotCapabilityKeychainItemOptions,
  service: string,
  label: string,
): BotCapabilityRollbackAnchor {
  const command = options.command ?? runSecurity;
  let accountPromise: Promise<string> | undefined;
  const account = (): Promise<string> => {
    accountPromise ??= Promise.resolve(
      typeof options.account === "function"
        ? options.account()
        : options.account,
    )
      .then(validateAccount)
      .catch((error) => {
        accountPromise = undefined;
        throw error;
      });
    return accountPromise;
  };

  const read = async (): Promise<string | null> => {
    const accountValue = await account();
    let result: BotCapabilitySecurityCommandResult;
    try {
      result = await command([
        "find-generic-password",
        "-a",
        accountValue,
        "-s",
        service,
        "-w",
      ]);
    } catch {
      throw new BotCapabilityUnavailableError(
        `The macOS Keychain ${label} is unavailable.`,
      );
    }
    if (result.exitCode === 44 || /could not be found/iu.test(result.stderr))
      return null;
    if (result.exitCode !== 0) {
      throw new BotCapabilityUnavailableError(
        `The macOS Keychain ${label} is unavailable.`,
      );
    }
    return validateValue(result.stdout.replace(/\r?\n$/u, ""));
  };

  return {
    load: read,

    async store(value, expected): Promise<void> {
      const safeValue = validateValue(value);
      const accountValue = await account();
      if ((await read()) !== expected) {
        throw new BotCapabilityUnavailableError(
          `${label} changed outside the active transaction.`,
        );
      }
      let result: BotCapabilitySecurityCommandResult;
      try {
        result = await command(
          [
            "add-generic-password",
            "-U",
            "-a",
            accountValue,
            "-s",
            service,
            "-w",
          ],
          safeValue,
        );
      } catch {
        throw new BotCapabilityUnavailableError(
          `The macOS Keychain ${label} could not be updated.`,
        );
      }
      if (result.exitCode !== 0) {
        throw new BotCapabilityUnavailableError(
          `The macOS Keychain ${label} could not be updated.`,
        );
      }
      if ((await read()) !== safeValue) {
        throw new BotCapabilityUnavailableError(
          `The macOS Keychain ${label} could not be verified.`,
        );
      }
    },
  };
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

function markerValue(state: BotCapabilityBootstrapMarkerState): string {
  if (
    (state.phase !== "pending" && state.phase !== "consumed") ||
    !/^[a-f0-9]{64}$/u.test(state.keyProof)
  ) {
    throw new BotCapabilityUnavailableError(
      "Bot bootstrap marker key proof is invalid.",
    );
  }
  return `${state.phase}:${state.keyProof}`;
}

function parseMarker(value: string): BotCapabilityBootstrapMarkerState {
  const match = MARKER_PATTERN.exec(value);
  if (!match) {
    throw new BotCapabilityUnavailableError("Bot bootstrap marker is invalid.");
  }
  return {
    phase: match[1] as BotCapabilityBootstrapMarkerState["phase"],
    keyProof: match[2]!,
  };
}

export function createBotCapabilityKeychainBootstrapMarker(
  options: BotCapabilityKeychainItemOptions,
): BotCapabilityBootstrapMarker {
  const item = createKeychainItem(
    options,
    BOOTSTRAP_SERVICE,
    "Bot bootstrap marker",
  );
  return {
    async load() {
      const value = await item.load();
      return value === null ? null : parseMarker(value);
    },
    async store(next, expected) {
      if (
        (next.phase === "pending" && expected !== null) ||
        (next.phase === "consumed" &&
          (expected?.phase !== "pending" ||
            expected.keyProof !== next.keyProof))
      ) {
        throw new BotCapabilityUnavailableError(
          "Bot bootstrap marker transition is invalid.",
        );
      }
      await item.store(
        markerValue(next),
        expected === null ? null : markerValue(expected),
      );
    },
  };
}
