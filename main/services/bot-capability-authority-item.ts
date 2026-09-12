import { createHash } from "node:crypto";
import * as path from "node:path";
import type { BotCapabilityBootstrapMarker, BotCapabilityBootstrapMarkerState, BotCapabilityRollbackAnchor } from "./bot-capability-state-checkpoint.js";
import { BotCapabilityUnavailableError } from "./bot-capability-store-core.js";
export const ROLLBACK_SERVICE = "com.aiden.bot-capability.rollback-authority.v1";
export const BOOTSTRAP_SERVICE = "com.aiden.bot-capability.bootstrap-consumed.v1";
export const TELEGRAM_BINDING_SERVICE = "com.aiden.telegram-bot-binding.rollback-authority.v1";
export const TELEGRAM_BINDING_BOOTSTRAP_SERVICE =
  "com.aiden.telegram-bot-binding.bootstrap-consumed.v1";
export const MAX_VALUE_BYTES = 1_024;
const ACCOUNT_PREFIX = "user-data:";
const MARKER_PATTERN = /^(pending|consumed):([a-f0-9]{64})$/u;
export interface AuthorityTransport {
  read(account: string): Promise<string | null>;
  write(account: string, value: string): Promise<void>;
}
export function botCapabilityAuthorityAccountForCanonicalRoot(
  root: string,
): string {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) {
    throw new BotCapabilityUnavailableError(
      "Bot rollback authority requires a canonical private user-data root.",
    );
  }
  return `${ACCOUNT_PREFIX}${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
}

export function validateAccount(value: string): string {
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

export function validateValue(value: string): string {
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

export interface BotCapabilityAuthorityItemOptions {
  account: string | (() => string | Promise<string>);
}

export function createAuthorityItem(
  options: BotCapabilityAuthorityItemOptions,
  transport: AuthorityTransport,
  label: string,
): BotCapabilityRollbackAnchor {
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
    try {
      const value = await transport.read(accountValue);
      return value === null ? null : validateValue(value);
    } catch {
      throw new BotCapabilityUnavailableError(`${label} is unavailable.`);
    }
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
      try {
        await transport.write(accountValue, safeValue);
      } catch {
        throw new BotCapabilityUnavailableError(`${label} could not be updated.`);
      }
      if ((await read()) !== safeValue) {
        throw new BotCapabilityUnavailableError(
          `${label} could not be verified.`,
        );
      }
    },
  };
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

export function createAuthorityBootstrapMarker(
  item: BotCapabilityRollbackAnchor,
): BotCapabilityBootstrapMarker {
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
